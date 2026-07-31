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

    // A URI may already name a database ("…/itsuki?retryWrites=true"). Passing
    // undefined lets the driver use that, and only falls back to the configured
    // name when the URI omits one.
    const fromUri = new URL(config.mongo.uri.replace(/^mongodb\+srv:/, 'https:').replace(/^mongodb:/, 'http:'))
      .pathname.replace(/^\//, '');
    const name = fromUri || config.mongo.dbName;

    client = c;
    database = c.db(name);

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
