/**
 * @file UserResolver.ts
 * @description Resolves a user ID to a display name in any context.
 *
 * The leaderboards are backed by GLOBAL data (economy.json and users.json are
 * not guild-scoped), but they used to render names with
 * `interaction.guild!.members.fetch(...)`. That non-null assertion made them
 * crash outright in a DM, and even inside a guild it showed "User#1234" for
 * anyone who happened not to be a member of that particular server.
 *
 * This falls back through progressively cheaper/weaker sources so a name is
 * always produced, with or without a guild.
 */

import type { Client, Guild } from 'discord.js';
import { getStore } from '../database/Store';

const usersDB = getStore('users');

export interface ResolveContext {
  guild?: Guild | null;
  client?: Client | null;
}

/** Best-effort display name for a user ID. Never throws. */
export async function resolveDisplayName(userId: string, ctx: ResolveContext): Promise<string> {
  const fallback = `User#${userId.slice(-4)}`;
  const { guild, client } = ctx;

  // 1. Guild member — the only source that knows server nicknames.
  if (guild) {
    const cachedMember = guild.members.cache.get(userId);
    if (cachedMember) return cachedMember.displayName;
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member) return member.displayName;
  }

  // 2. Already-cached user — free.
  const cachedUser = client?.users.cache.get(userId);
  if (cachedUser) return cachedUser.username;

  // 3. Username the bot recorded when it last saw them.
  const stored = await usersDB.get(`${userId}.username`).catch(() => null);
  if (typeof stored === 'string' && stored.trim()) return stored;

  // 4. One API lookup as a last resort.
  if (client) {
    const fetched = await client.users.fetch(userId).catch(() => null);
    if (fetched) return fetched.username;
  }

  return fallback;
}

/** Resolves many IDs at once, preserving input order. */
export async function resolveDisplayNames(
  userIds: string[],
  ctx: ResolveContext,
): Promise<string[]> {
  return Promise.all(userIds.map((id) => resolveDisplayName(id, ctx)));
}
