import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction, type TextChannel,
} from 'discord.js';
import { Command } from '../../structures/Command';
import VerificationManager, { METHODS, type VerifyMethod } from '../../managers/VerificationManager';
import * as CB from '../../builders/ComponentBuilder';
import logger from '../../utils/Logger';

/** The panel members interact with. Exported so /verify post can rebuild it. */
export function buildVerifyPanel(guildId: string, method: VerifyMethod, note: string | null): ContainerBuilder {
  const blurb: Record<VerifyMethod, string> = {
    button: 'Click the button below to verify and gain access.',
    captcha: 'Click below to receive an image captcha, then type the code you see.',
    math: 'Click below for a short maths question.',
    passphrase: 'Click below and enter the passphrase from the rules.',
    age: 'Click below — access is granted automatically if your account is old enough.',
  };

  const c = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# ✅ Server Verification',
      blurb[method],
    ].join('\n')));

  if (note) {
    c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(note));
  }

  c.addActionRowComponents(
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`verify_start:${guildId}`)
        .setLabel('Verify')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
    ),
  );
  return c;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('verify').setDescription('Set up and manage server verification.')
    .addSubcommand((s) => s.setName('setup').setDescription('Configure verification')
      .addStringOption((o) => o.setName('method').setDescription('Verification method').setRequired(true)
        .addChoices(...METHODS.map((m) => ({ name: `${m.label} — ${m.description}`.slice(0, 100), value: m.id }))))
      .addRoleOption((o) => o.setName('role').setDescription('Role granted on success').setRequired(true))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post the panel').setRequired(true)
        .addChannelTypes(ChannelType.GuildText))
      .addStringOption((o) => o.setName('passphrase').setDescription('Required for the passphrase method'))
      .addIntegerOption((o) => o.setName('min_account_age').setDescription('Minimum account age in days (0 = off)').setMinValue(0).setMaxValue(3650))
      .addRoleOption((o) => o.setName('remove_role').setDescription('Role to REMOVE on success (e.g. Unverified)'))
      .addChannelOption((o) => o.setName('log_channel').setDescription('Where to log verifications')
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((s) => s.setName('post').setDescription('Re-post the verification panel'))
    .addSubcommand((s) => s.setName('status').setDescription('Show the current configuration'))
    .addSubcommand((s) => s.setName('disable').setDescription('Turn verification off'))
    .addSubcommand((s) => s.setName('user').setDescription('Manually verify a member')
      .addUserOption((o) => o.setName('member').setDescription('Member to verify').setRequired(true)))
    // ManageRoles, not ManageGuild: this command configures (and /verify user
    // performs) an automatic role grant, so the permission it requires should be
    // the one Discord requires for the operation itself. Gating on ManageGuild
    // let a moderator with no role-management rights of their own decide which
    // role every member receives.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ManageRoles'],

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['setup', 'post', 'status', 'disable', 'user'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;

    // ── status ──────────────────────────────────────────────────────────────
    if (sub === 'status') {
      const cfg = await VerificationManager.getConfig(guild.id);
      const method = METHODS.find((m) => m.id === cfg.method);
      const roleWarning = cfg.roleId ? VerificationManager.canAssign(guild, cfg.roleId) : null;

      return interaction.editReply({ ...CB.successResponse(
        cfg.enabled ? 'Verification: ON' : 'Verification: OFF',
        [
          `**Method:** ${method?.label ?? cfg.method}`,
          `**Role granted:** ${cfg.roleId ? `<@&${cfg.roleId}>` : '*not set*'}`,
          cfg.removeRoleId ? `**Role removed:** <@&${cfg.removeRoleId}>` : '',
          `**Panel channel:** ${cfg.channelId ? `<#${cfg.channelId}>` : '*not set*'}`,
          `**Min account age:** ${cfg.minAccountAgeDays > 0 ? `${cfg.minAccountAgeDays} days` : 'off'}`,
          cfg.method === 'passphrase' ? `**Passphrase:** ${cfg.passphrase ? '`set`' : '*not set*'}` : '',
          `**Log channel:** ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : 'off'}`,
          roleWarning ? `\n⚠️ **Problem:** ${roleWarning}` : '',
        ].filter(Boolean).join('\n'),
      ) } as never);
    }

    // ── disable ─────────────────────────────────────────────────────────────
    if (sub === 'disable') {
      await VerificationManager.setConfig(guild.id, { enabled: false });
      return interaction.editReply({ ...CB.successResponse(
        'Verification Disabled',
        'The panel button will stop working. Settings are kept, so `/verify post` can re-enable it later.',
      ) } as never);
    }

    // ── user (manual override) ──────────────────────────────────────────────
    if (sub === 'user') {
      const target = interaction.options.getUser('member');
      if (!target) return interaction.editReply({ ...CB.errorResponse('Missing Member', 'Pick a member.') } as never);

      const cfg = await VerificationManager.getConfig(guild.id);
      if (!cfg.roleId) {
        return interaction.editReply({ ...CB.errorResponse(
          'Not Configured', 'Run `/verify setup` first so there is a role to grant.',
        ) } as never);
      }

      const member = guild.members.cache.get(target.id)
        ?? await guild.members.fetch(target.id).catch(() => null);
      if (!member) {
        return interaction.editReply({ ...CB.errorResponse('Not a Member', `**${target.username}** is not in this server.`) } as never);
      }

      const result = await VerificationManager.grant(member, cfg);
      if (!result.ok) {
        return interaction.editReply({ ...CB.errorResponse('Could Not Verify', result.reason ?? 'Unknown error.') } as never);
      }

      await VerificationManager.log(guild, cfg,
        `✅ **${target.tag ?? target.username}** was manually verified by ${interaction.user.tag ?? interaction.user.username}.`);

      return interaction.editReply({ ...CB.successResponse(
        result.alreadyVerified ? 'Already Verified' : 'Member Verified',
        result.alreadyVerified
          ? `**${target.username}** already has <@&${cfg.roleId}>.`
          : `**${target.username}** has been given <@&${cfg.roleId}>.`,
      ) } as never);
    }

    // ── post ────────────────────────────────────────────────────────────────
    if (sub === 'post') {
      const cfg = await VerificationManager.getConfig(guild.id);
      if (!cfg.roleId || !cfg.channelId) {
        return interaction.editReply({ ...CB.errorResponse(
          'Not Configured', 'Run `/verify setup` first.',
        ) } as never);
      }

      const channel = guild.channels.cache.get(cfg.channelId) as TextChannel | undefined;
      if (!channel || !('send' in channel)) {
        return interaction.editReply({ ...CB.errorResponse(
          'Channel Missing', 'The configured panel channel no longer exists. Run `/verify setup` again.',
        ) } as never);
      }

      const note = cfg.minAccountAgeDays > 0
        ? `-# Accounts must be at least **${cfg.minAccountAgeDays} days** old.`
        : null;

      try {
        const sent = await channel.send({
          components: [buildVerifyPanel(guild.id, cfg.method, note)],
          flags: MessageFlags.IsComponentsV2,
        } as never);
        await VerificationManager.setConfig(guild.id, { enabled: true, messageId: sent.id });
        return interaction.editReply({ ...CB.successResponse(
          'Panel Posted', `Verification is live in ${channel}.`,
        ) } as never);
      } catch (err) {
        return interaction.editReply({ ...CB.errorResponse(
          'Could Not Post',
          `${(err as Error).message}\n-# Check I have **View Channel** and **Send Messages** in ${channel}.`,
        ) } as never);
      }
    }

    // ── setup ───────────────────────────────────────────────────────────────
    const method = interaction.options.getString('method') as VerifyMethod;
    const role = interaction.options.getRole('role');
    const channel = interaction.options.getChannel('channel') as TextChannel | null;
    const passphrase = interaction.options.getString('passphrase');
    const minAge = interaction.options.getInteger('min_account_age') ?? 0;
    const removeRole = interaction.options.getRole('remove_role');
    const logChannel = interaction.options.getChannel('log_channel');

    if (!METHODS.some((m) => m.id === method)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Method', `Choose one of: ${METHODS.map((m) => `\`${m.id}\``).join(', ')}.`,
      ) } as never);
    }
    if (!role || !channel) {
      return interaction.editReply({ ...CB.errorResponse('Missing Options', 'A role and a channel are both required.') } as never);
    }

    // Validate the role BEFORE saving, so setup can't succeed into a state that
    // silently fails for every member who clicks. Passing the moderator is what
    // enables the "not above your own highest role" and "no privileged
    // permissions" checks — without it, setup was a privilege-escalation route.
    const moderator = await guild.members.fetch(interaction.user.id).catch(() => null);
    const denial = VerificationManager.canAssign(guild, role.id, moderator);
    if (denial) {
      return interaction.editReply({ ...CB.errorResponse('Role Not Assignable', denial) } as never);
    }
    if (removeRole) {
      const removeDenial = VerificationManager.canAssign(guild, removeRole.id, moderator);
      if (removeDenial) {
        return interaction.editReply({ ...CB.errorResponse(
          'Remove-Role Not Manageable', `For the role to remove: ${removeDenial}`,
        ) } as never);
      }
      if (removeRole.id === role.id) {
        return interaction.editReply({ ...CB.errorResponse(
          'Conflicting Roles', 'The role to grant and the role to remove cannot be the same.',
        ) } as never);
      }
    }
    // The passphrase method is unusable without a phrase.
    if (method === 'passphrase' && !passphrase?.trim()) {
      return interaction.editReply({ ...CB.errorResponse(
        'Passphrase Required', 'The passphrase method needs the `passphrase` option set.',
      ) } as never);
    }
    // Likewise the age gate needs a threshold.
    if (method === 'age' && minAge <= 0) {
      return interaction.editReply({ ...CB.errorResponse(
        'Age Required', 'The account-age method needs `min_account_age` set to at least 1 day.',
      ) } as never);
    }

    const cfg = await VerificationManager.setConfig(guild.id, {
      enabled: true,
      method,
      roleId: role.id,
      channelId: channel.id,
      passphrase: passphrase?.trim() ?? null,
      minAccountAgeDays: minAge,
      removeRoleId: removeRole?.id ?? null,
      logChannelId: logChannel?.id ?? null,
    });

    const note = cfg.minAccountAgeDays > 0
      ? `-# Accounts must be at least **${cfg.minAccountAgeDays} days** old.`
      : null;

    let posted = false;
    try {
      const sent = await channel.send({
        components: [buildVerifyPanel(guild.id, method, note)],
        flags: MessageFlags.IsComponentsV2,
      } as never);
      await VerificationManager.setConfig(guild.id, { messageId: sent.id });
      posted = true;
    } catch (err) {
      logger.warn(`[Verify] Could not post panel in ${guild.id}: ${(err as Error).message}`);
    }

    const methodMeta = METHODS.find((m) => m.id === method);
    return interaction.editReply({ ...CB.successResponse(
      'Verification Configured',
      [
        `**Method:** ${methodMeta?.label}`,
        `**Grants:** ${role}`,
        removeRole ? `**Removes:** ${removeRole}` : '',
        `**Panel:** ${channel}`,
        minAge > 0 ? `**Min account age:** ${minAge} days` : '',
        logChannel ? `**Logging to:** ${logChannel}` : '',
        '',
        posted
          ? '✅ Panel posted and verification is live.'
          : `⚠️ Settings saved, but I could not post in ${channel}. Fix my permissions there and run \`/verify post\`.`,
      ].filter(Boolean).join('\n'),
    ) } as never);
  },
});
