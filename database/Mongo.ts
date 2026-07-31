/**
 * @file Mongo.ts
 * @description The single shared MongoDB connection.
 *
 * Stores are constructed at module load (`const db = getStore('economy')`), long
 * before a connection could exist, so connecting cannot be part of that. Instead
 * every store method awaits `getDb()`, which resolves immediately once connected
 * and otherwise joins the in-flight connect. `connect()` is still called
 * explicitly during boot so a bad URI fails before the bot logs in, rather than
 * surfacing as a broken command later.
 */

import { MongoClient, type Db } from 'mongodb';
import config from '../config/config';
import logger from '../utils/Logger';

let client: MongoClient | null = null;
let database: Db | null = null;
/** In-flight connect, shared so concurrent callers never open two clients. */
let connecting: Promise<Db> | null = null;

/**
 * The database named in a connection string, or '' if it names none.
 *
 * Hand-parsed rather than via `new URL()`, which THROWS on a replica-set URI:
 * "mongodb://h1:27017,h2:27017/db" makes the port "27017,h2:27017", which is not
 * a valid URL, so the bot could never start against a replica set.
 */
export function databaseFromUri(uri: string): string {
  const afterScheme = String(uri ?? '').replace(/^mongodb(\+srv)?:\/\//i, '');
  // lastIndexOf so an unencoded '@' inside a password cannot truncate the host
  // list and hide the path.
  const at = afterScheme.lastIndexOf('@');
  const hostsAndPath = at === -1 ? afterScheme : afterScheme.slice(at + 1);

  const slash = hostsAndPath.indexOf('/');
  if (slash === -1) return '';

  const path = hostsAndPath.slice(slash + 1).split(/[?#]/)[0] ?? '';
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function isConnected(): boolean {
  return database !== null;
}

/**
 * Opens the connection. Safe to call more than once — later calls reuse the
 * existing client or join the in-flight attempt.
 */
export function connect(): Promise<Db> {
  if (database) return Promise.resolve(database);
  if (connecting) return connecting;

  if (!config.mongo.uri) {
    return Promise.reject(new Error(
      'MONGO_URI is not set. The bot stores everything in MongoDB — '
      + 'add MONGO_URI to your .env (see .env.example).',
    ));
  }

  connecting = (async () => {
    const started = Date.now();
    const c = new MongoClient(config.mongo.uri, {
      serverSelectionTimeoutMS: config.mongo.serverSelectionTimeoutMS,
      // Retries are the driver's job; without them a brief primary election
      // turns into a failed command for the user.
      retryWrites: true,
      retryReads: true,
    });

    await c.connect();

    // A URI may already name a database ("…/itsuki?retryWrites=true"). When it
    // does, db() with no argument uses it, which keeps the driver
    // authoritative; otherwise fall back to the configured name.
    client = c;
    database = databaseFromUri(config.mongo.uri) ? c.db() : c.db(config.mongo.dbName);
    const name = database.databaseName;

    // Prove the connection actually works. `connect()` can resolve against an
    // unreachable replica set member, and a ping surfaces auth failures here
    // instead of on the first command.
    await database.command({ ping: 1 });

    logger.info(`[Mongo] Connected to "${name}" in ${Date.now() - started}ms`);

    c.on('serverHeartbeatFailed', () => logger.warn('[Mongo] Heartbeat failed — connection may be degraded.'));
    c.on('topologyClosed', () => { database = null; });

    return database;
  })();

  // Clear the memo on failure so a later attempt can retry instead of
  // permanently resolving to the same rejected promise.
  connecting.catch(() => { connecting = null; });

  return connecting;
}

/** The connected database, connecting first if necessary. */
export function getDb(): Promise<Db> {
  return database ? Promise.resolve(database) : connect();
}

/** Round-trip latency in milliseconds, for status commands. */
export async function ping(): Promise<number> {
  const db = await getDb();
  const started = Date.now();
  await db.command({ ping: 1 });
  return Date.now() - started;
}

export async function close(): Promise<void> {
  if (!client) return;
  try {
    await client.close();
    logger.info('[Mongo] Connection closed.');
  } catch (err) {
    logger.warn(`[Mongo] Error while closing: ${(err as Error).message}`);
  } finally {
    client = null;
    database = null;
    connecting = null;
  }
}

export default { connect, getDb, close, ping, isConnected };
