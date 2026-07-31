import {
  SlashCommandBuilder, MessageFlags, ChannelType, PermissionFlagsBits,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction, type TextChannel,
} from 'discord.js';
import { Command } from '../../structures/Command';
import VoteManager, { PROVIDERS } from '../../managers/VoteManager';
import VoteWebhookServer from '../../services/VoteWebhookServer';
import * as CB from '../../builders/ComponentBuilder';
import config from '../../config/config';

/**
 * Vote notifier setup.
 *
 * Guild-scoped (channels belong to a server) but restricted to bot owners:
 * announcing every vote the bot receives, in any server, is a bot-wide decision
 * rather than a per-server one.
 */
export default new Command({
  data: new SlashCommandBuilder()
    .setName('voteconfig').setDescription('(Owner) Configure vote notifications for this server.')
    .addSubcommand((s) => s.setName('topgg').setDescription('Set the Top.gg announcement channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel for Top.gg votes').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('dbl').setDescription('Set the Discord Bot List announcement channel')
      .addChannelOption((o) => o.setName('channel').setDescription('Channel for DBL votes').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
    .addSubcommand((s) => s.setName('role').setDescription('Role granted to voters for 24 hours')
      .addRoleOption((o) => o.setName('role').setDescription('Voter role (omit to clear)')))
    .addSubcommand((s) => s.setName('toggle').setDescription('Enable or disable notifications here')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand((s) => s.setName('status').setDescription('Show the current setup and webhook state'))
    .addSubcommand((s) => s.setName('test').setDescription('Post a sample vote message to check the channels')),
  category: 'owner',
  ownerOnly: true,
  guildOnly: true,
  cooldown: 0,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['topgg', 'dbl', 'role', 'toggle', 'status', 'test'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;

    // ── status ──────────────────────────────────────────────────────────────
    if (sub === 'status') {
      const cfg = await VoteManager.getConfig(guild.id);
      const active = VoteWebhookServer.configuredProviders();
      const port = Number(process.env.VOTE_SERVER_PORT) || 3001;

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# 🗳️ Vote Notifier',
          `**Notifications here:** ${cfg.enabled ? '🟢 on' : '🔴 off'}`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Top.gg channel:** ${cfg.topggChannelId ? `<#${cfg.topggChannelId}>` : '*not set*'}`,
          `**DBL channel:** ${cfg.dblChannelId ? `<#${cfg.dblChannelId}>` : '*not set*'}`,
          `**Voter role:** ${cfg.voterRoleId ? `<@&${cfg.voterRoleId}>` : '*not set*'}`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '**Webhook receiver**',
          `> Server running: ${VoteWebhookServer.isRunning() ? '🟢 yes' : '🔴 no'}`,
          `> Providers with a secret: ${active.length ? active.join(', ') : '*none*'}`,
          '',
          'Point each site\'s webhook at:',
          `> \`POST http://<your-host>:${port}/vote/topgg\``,
          `> \`POST http://<your-host>:${port}/vote/dbl\``,
          '',
          '-# A provider with no secret in `.env` is disabled, not left open —',
          '-# otherwise anyone could forge votes. See `.env.example`.',
        ].join('\n')));
      return interaction.editReply({ components: [c] });
    }

    // ── toggle ──────────────────────────────────────────────────────────────
    if (sub === 'toggle') {
      const enabled = interaction.options.getBoolean('enabled') ?? true;
      await VoteManager.setConfig(guild.id, { enabled });
      return interaction.editReply({ ...CB.successResponse(
        enabled ? 'Notifications Enabled' : 'Notifications Disabled',
        enabled
          ? 'Vote announcements will be posted in the configured channels.'
          : 'Vote announcements are paused. Channel settings are kept.',
      ) } as never);
    }

    // ── role ────────────────────────────────────────────────────────────────
    if (sub === 'role') {
      const role = interaction.options.getRole('role');
      if (!role) {
        await VoteManager.setConfig(guild.id, { voterRoleId: null });
        return interaction.editReply({ ...CB.successResponse('Voter Role Cleared', 'No role will be granted for voting.') } as never);
      }

      // Verify assignability now rather than failing silently on every vote.
      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need **Manage Roles** to grant a voter role.') } as never);
      }
      if (me.roles.highest.comparePositionTo(role.id) <= 0) {
        return interaction.editReply({ ...CB.errorResponse(
          'Role Too High', `My highest role must be above ${role}. Move it up in Server Settings → Roles.`,
        ) } as never);
      }

      await VoteManager.setConfig(guild.id, { voterRoleId: role.id });
      return interaction.editReply({ ...CB.successResponse(
        'Voter Role Set', `Voters will receive ${role} for 24 hours after voting.`,
      ) } as never);
    }

    // ── test ────────────────────────────────────────────────────────────────
    if (sub === 'test') {
      const cfg = await VoteManager.getConfig(guild.id);
      const results: string[] = [];

      for (const [provider, channelId] of [
        ['topgg', cfg.topggChannelId] as const,
        ['dbl', cfg.dblChannelId] as const,
      ]) {
        if (!channelId) { results.push(`**${PROVIDERS[provider].label}** — no channel set`); continue; }
        const channel = guild.channels.cache.get(channelId) as TextChannel | undefined;
        if (!channel?.send) { results.push(`**${PROVIDERS[provider].label}** — channel missing`); continue; }
        try {
          await channel.send({
            components: [new ContainerBuilder().addTextDisplayComponents(
              new TextDisplayBuilder().setContent([
                `### 🗳️ Test — ${PROVIDERS[provider].label}`,
                `This is what a vote announcement looks like.`,
                '-# Triggered by `/voteconfig test`.',
              ].join('\n')),
            )],
            flags: MessageFlags.IsComponentsV2,
          } as never);
          results.push(`**${PROVIDERS[provider].label}** — ✅ posted in ${channel}`);
        } catch (err) {
          results.push(`**${PROVIDERS[provider].label}** — ❌ ${(err as Error).message}`);
        }
      }

      return interaction.editReply({ ...CB.successResponse('Test Results', results.join('\n')) } as never);
    }

    // ── topgg / dbl channel ─────────────────────────────────────────────────
    const channel = interaction.options.getChannel('channel') as TextChannel | null;
    if (!channel) {
      return interaction.editReply({ ...CB.errorResponse('Missing Channel', 'Pick a channel.') } as never);
    }

    // Confirm the bot can post there before saving, or every vote silently
    // fails to announce.
    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Cannot Post There', `I need **View Channel** and **Send Messages** in ${channel}.`,
      ) } as never);
    }

    const provider = sub as 'topgg' | 'dbl';
    await VoteManager.setConfig(guild.id, {
      [provider === 'topgg' ? 'topggChannelId' : 'dblChannelId']: channel.id,
    });

    const secretSet = VoteWebhookServer.configuredProviders().includes(provider);
    return interaction.editReply({ ...CB.successResponse(
      `${PROVIDERS[provider].label} Channel Set`,
      [
        `${PROVIDERS[provider].label} votes will be announced in ${channel}.`,
        secretSet
          ? '-# Webhook secret is configured, so this is live.'
          : `-# ⚠️ \`${provider === 'topgg' ? 'TOPGG_WEBHOOK_AUTH' : 'DBL_WEBHOOK_AUTH'}\` is not set in \`.env\`, so no votes will arrive yet. Run \`/voteconfig status\` for the URL to configure.`,
      ].join('\n'),
    ) } as never);
  },
});
