/**
 * @file VoteAnnouncer.ts
 * @description Handles an incoming vote: records it, announces it in the
 * configured channels, grants the voter role, and thanks the user.
 *
 * Kept separate from the webhook server so the transport (HTTP) and the
 * behaviour (rewards, announcements) can be reasoned about — and tested —
 * independently.
 */

import {
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  MessageFlags, type Client, type TextChannel,
} from 'discord.js';
import VoteManager, { PROVIDERS, type VoteProvider } from '../managers/VoteManager';
import UserManager from '../managers/UserManager';
import logger from '../utils/Logger';

/** Coins awarded per vote. Weekend top.gg votes count double, as the site does. */
const VOTE_REWARD = 750;
/** How long a voter keeps the configured role. */
const VOTER_ROLE_MS = 24 * 60 * 60 * 1000;

export interface IncomingVote {
  provider: VoteProvider;
  userId: string;
  isWeekend: boolean;
  isTest: boolean;
}

const VoteAnnouncer = {
  async handle(client: Client, vote: IncomingVote): Promise<void> {
    const provider = PROVIDERS[vote.provider];

    // A test payload from the site's dashboard should confirm the plumbing works
    // without paying out or inflating anyone's streak.
    if (vote.isTest) {
      logger.info(`[Votes] Test webhook received from ${provider.label} — plumbing OK.`);
      return;
    }

    const { record, streakIncreased } = await VoteManager.recordVote(vote.userId, vote.provider);

    // top.gg counts weekend votes double, so the reward matches.
    const multiplier = vote.provider === 'topgg' && vote.isWeekend ? 2 : 1;
    const reward = VOTE_REWARD * multiplier;
    await UserManager.addWallet(vote.userId, reward);
    await UserManager.recordTransaction(
      vote.userId, 'vote', reward, `Voted on ${provider.label}${multiplier > 1 ? ' (weekend ×2)' : ''}`,
    );

    const user = await client.users.fetch(vote.userId).catch(() => null);
    const username = user?.username ?? `User ${vote.userId.slice(-4)}`;
    const total = (Number(record.totalTopgg) || 0) + (Number(record.totalDbl) || 0);

    logger.info(`[Votes] ${username} voted on ${provider.label} (total ${total}, streak ${record.streak})`);

    // ── Thank-you DM ────────────────────────────────────────────────────────
    // Failure is expected and silent — closed DMs are common.
    if (user) {
      await user.send({
        content: [
          `Thanks for voting on **${provider.label}**!`,
          `You earned **${reward.toLocaleString('en-US')}** coins${multiplier > 1 ? ' (weekend bonus ×2)' : ''}.`,
          record.streak > 1 ? `🔥 **${record.streak}-day streak**` : '',
          '',
          `-# You can vote again in 12 hours. Turn reminders off with \`/vote reminders\`.`,
        ].filter(Boolean).join('\n'),
      }).catch(() => null);
    }

    // ── Announcements ───────────────────────────────────────────────────────
    const targets = await VoteManager.guildsWithNotifier(vote.provider);
    for (const target of targets) {
      const guild = client.guilds.cache.get(target.guildId);
      if (!guild) continue;

      const channel = guild.channels.cache.get(target.channelId) as TextChannel | undefined;
      if (!channel?.send) continue;

      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `### 🗳️ New vote on ${provider.label}`,
          `<@${vote.userId}> just voted — thank you!`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Reward:** ${reward.toLocaleString('en-US')} coins${multiplier > 1 ? ' (weekend ×2)' : ''}`,
          `**Total votes:** ${total}`,
          streakIncreased && record.streak > 1 ? `**Streak:** 🔥 ${record.streak} days` : '',
          `-# Vote at ${provider.url(client.user?.id ?? '')}`,
        ].filter(Boolean).join('\n')));

      await channel.send({
        components: [container],
        flags: MessageFlags.IsComponentsV2,
        // The voter is mentioned in the body; suppressing the ping keeps a busy
        // notifier channel from being a nuisance.
        allowedMentions: { parse: [] },
      } as never).catch((err: Error) =>
        logger.debug(`[Votes] Announce failed in ${target.guildId}: ${err.message}`));

      // ── Voter role ────────────────────────────────────────────────────────
      if (target.config.voterRoleId) {
        const member = guild.members.cache.get(vote.userId)
          ?? await guild.members.fetch(vote.userId).catch(() => null);
        if (member) {
          await member.roles.add(target.config.voterRoleId, 'Voted for the bot').catch(() => null);
          // Scheduled removal only — if the process restarts the role lingers,
          // which is far preferable to holding the event loop open for a day.
          const timer = setTimeout(() => {
            void member.roles.remove(target.config.voterRoleId!, 'Voter role expired').catch(() => null);
          }, VOTER_ROLE_MS);
          if (typeof timer.unref === 'function') timer.unref();
        }
      }
    }
  },

  /**
   * Sends due reminders. Called on a schedule.
   *
   * Each user is marked as reminded before the DM is attempted, so a failure
   * (closed DMs) doesn't cause the same person to be retried every sweep.
   */
  async sendReminders(client: Client): Promise<number> {
    const due = await VoteManager.dueForReminder();
    let sent = 0;

    for (const { userId, provider } of due) {
      await VoteManager.markReminded(userId, provider);

      const user = await client.users.fetch(userId).catch(() => null);
      if (!user) continue;

      const meta = PROVIDERS[provider];
      const ok = await user.send({
        content: [
          `⏰ Your **${meta.label}** vote is ready again!`,
          meta.url(client.user?.id ?? ''),
          '',
          '-# Turn these off with `/vote reminders enabled:false`.',
        ].join('\n'),
      }).then(() => true).catch(() => false);

      if (ok) sent++;
    }

    if (sent) logger.info(`[Votes] Sent ${sent} vote reminder(s).`);
    return sent;
  },
};

export default VoteAnnouncer;
