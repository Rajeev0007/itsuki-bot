import {
  SlashCommandBuilder, MessageFlags, PermissionFlagsBits, ChannelType,
  ContainerBuilder, TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction, type TextChannel, type GuildMember,
} from 'discord.js';
import { Command } from '../../structures/Command';
import WelcomerManager, { type WelcomerEvent } from '../../managers/WelcomerManager';
import {
  renderTemplate, describeTemplate, isRenderable, PLACEHOLDERS,
  type TemplateStyle,
} from '../../services/MessageTemplate';
import { openBuilder } from '../../services/TemplateBuilderUI';
import * as CB from '../../builders/ComponentBuilder';

/**
 * Welcome / goodbye setup.
 *
 * Two setup routes, as requested:
 *   quick   — one command, sensible defaults, done in seconds
 *   builder — an interactive panel exposing every embed and V2 field
 * Both write the same stored template, so you can start with `quick` and refine
 * it in the builder later without starting over.
 */
export default new Command({
  data: new SlashCommandBuilder()
    .setName('welcomer').setDescription('Set up welcome and goodbye messages.')
    .addSubcommand((s) => s.setName('quick').setDescription('Fast setup with a ready-made design')
      .addStringOption((o) => o.setName('event').setDescription('Which message').setRequired(true)
        .addChoices({ name: 'Welcome (member joins)', value: 'welcome' }, { name: 'Goodbye (member leaves)', value: 'goodbye' }))
      .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption((o) => o.setName('style').setDescription('How it should look')
        .addChoices({ name: 'Embed (classic)', value: 'embed' }, { name: 'Components V2 (modern)', value: 'v2' }))
      .addStringOption((o) => o.setName('message').setDescription('Custom description — placeholders supported')))
    .addSubcommand((s) => s.setName('builder').setDescription('Open the full interactive builder')
      .addStringOption((o) => o.setName('event').setDescription('Which message').setRequired(true)
        .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Goodbye', value: 'goodbye' })))
    .addSubcommand((s) => s.setName('style').setDescription('Switch between embed and Components V2')
      .addStringOption((o) => o.setName('event').setDescription('Which message').setRequired(true)
        .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Goodbye', value: 'goodbye' }))
      .addStringOption((o) => o.setName('style').setDescription('Rendering style').setRequired(true)
        .addChoices({ name: 'Embed (classic)', value: 'embed' }, { name: 'Components V2 (modern)', value: 'v2' })))
    .addSubcommand((s) => s.setName('autorole').setDescription('Roles given automatically on join')
      .addRoleOption((o) => o.setName('role').setDescription('Role to add or remove from the list').setRequired(true)))
    .addSubcommand((s) => s.setName('toggle').setDescription('Turn a message on or off')
      .addStringOption((o) => o.setName('event').setDescription('Which message').setRequired(true)
        .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Goodbye', value: 'goodbye' }))
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand((s) => s.setName('dm').setDescription('Also send new members a private welcome DM')
      .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
    .addSubcommand((s) => s.setName('dmbuilder').setDescription('Build the private welcome DM'))
    .addSubcommand((s) => s.setName('options').setDescription('Extra behaviour settings')
      .addStringOption((o) => o.setName('event').setDescription('Which message').setRequired(true)
        .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Goodbye', value: 'goodbye' }))
      .addIntegerOption((o) => o.setName('delete_after').setDescription('Delete the message after N seconds (0 = keep forever)')
        .setMinValue(0).setMaxValue(3600)))
    .addSubcommand((s) => s.setName('test').setDescription('Preview a message as if you just joined')
      .addStringOption((o) => o.setName('event').setDescription('Which message').setRequired(true)
        .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Goodbye', value: 'goodbye' })))
    .addSubcommand((s) => s.setName('status').setDescription('Show the current setup'))
    .addSubcommand((s) => s.setName('variables').setDescription('List every available placeholder'))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  category: 'moderation',
  guildOnly: true,
  permissions: ['ManageGuild'],
  cooldown: 3_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = [
      'quick', 'builder', 'style', 'autorole', 'toggle', 'test', 'status',
      'variables', 'dm', 'dmbuilder', 'options',
    ];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const guild = interaction.guild!;
    const eventOpt = (interaction.options.getString('event') ?? 'welcome') as WelcomerEvent;
    const event: WelcomerEvent = eventOpt === 'goodbye' ? 'goodbye' : 'welcome';

    // ── variables ───────────────────────────────────────────────────────────
    if (sub === 'variables') {
      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          '# 🏷️ Placeholders\nUse these anywhere in a welcome or goodbye message.',
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          PLACEHOLDERS.map((v) => `\`${v.token}\` — ${v.description}`).join('\n'),
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          '-# Unknown placeholders are left as-is rather than blanked, so typos stay visible.',
        ));
      return interaction.editReply({ components: [c] });
    }

    // ── status ──────────────────────────────────────────────────────────────
    if (sub === 'status') {
      const [welcome, goodbye] = await Promise.all([
        WelcomerManager.getConfig(guild.id, 'welcome'),
        WelcomerManager.getConfig(guild.id, 'goodbye'),
      ]);

      const block = (label: string, cfg: typeof welcome) => [
        `**${label}:** ${cfg.enabled ? '🟢 on' : '🔴 off'}`,
        `> Channel: ${cfg.channelId ? `<#${cfg.channelId}>` : '*not set*'}`,
        `> Style: **${cfg.template.style === 'v2' ? 'Components V2' : 'Embed'}**`,
        `> Content: ${isRenderable(cfg.template) ? 'configured' : '*empty*'}`,
        cfg.deleteAfter > 0 ? `> Auto-delete after ${cfg.deleteAfter}s` : '',
        // DMs only apply to joins, so this line is meaningless for goodbyes.
        label === 'Welcome'
          ? `> Private DM: ${cfg.dmEnabled ? `🟢 on (${cfg.dmTemplate?.style === 'v2' ? 'V2' : 'Embed'})` : '🔴 off'}`
          : '',
      ].filter(Boolean).join('\n');

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 👋 Welcomer'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          [block('Welcome', welcome), '', block('Goodbye', goodbye)].join('\n'),
        ));

      if (welcome.autoRoleIds.length) {
        c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `**Auto-roles:** ${welcome.autoRoleIds.map((r) => `<@&${r}>`).join(' ')}`,
          ));
      }
      return interaction.editReply({ components: [c] });
    }

    // ── toggle ──────────────────────────────────────────────────────────────
    if (sub === 'toggle') {
      const enabled = interaction.options.getBoolean('enabled') ?? true;
      const cfg = await WelcomerManager.getConfig(guild.id, event);

      // Enabling something with no channel would fail silently on every join.
      if (enabled && !cfg.channelId) {
        return interaction.editReply({ ...CB.errorResponse(
          'No Channel Set', `Run \`/welcomer quick event:${event}\` first to choose a channel.`,
        ) } as never);
      }
      await WelcomerManager.setConfig(guild.id, event, { enabled });
      return interaction.editReply({ ...CB.successResponse(
        enabled ? `${event === 'welcome' ? 'Welcome' : 'Goodbye'} Enabled` : 'Disabled',
        enabled ? `Messages will post in <#${cfg.channelId}>.` : 'Settings are kept, nothing will be posted.',
      ) } as never);
    }

    // ── autorole ────────────────────────────────────────────────────────────
    if (sub === 'autorole') {
      const role = interaction.options.getRole('role');
      if (!role) return interaction.editReply({ ...CB.errorResponse('Missing Role', 'Pick a role.') } as never);

      const me = guild.members.me;
      if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return interaction.editReply({ ...CB.errorResponse('Missing Permission', 'I need **Manage Roles**.') } as never);
      }
      // Validate now, not on every join.
      if (me.roles.highest.comparePositionTo(role.id) <= 0) {
        return interaction.editReply({ ...CB.errorResponse(
          'Role Too High', `My highest role must be above ${role}.`,
        ) } as never);
      }

      const cfg = await WelcomerManager.getConfig(guild.id, 'welcome');
      const has = cfg.autoRoleIds.includes(role.id);
      const next = has
        ? cfg.autoRoleIds.filter((r) => r !== role.id)
        : [...cfg.autoRoleIds, role.id].slice(0, 5);

      await WelcomerManager.setConfig(guild.id, 'welcome', { autoRoleIds: next });
      return interaction.editReply({ ...CB.successResponse(
        has ? 'Auto-role Removed' : 'Auto-role Added',
        [
          has ? `${role} will no longer be given on join.` : `${role} will be given to new members.`,
          next.length ? `**Current:** ${next.map((r) => `<@&${r}>`).join(' ')}` : '*No auto-roles set.*',
          '-# Maximum 5 auto-roles.',
        ].join('\n'),
      ) } as never);
    }

    // ── dm toggle ───────────────────────────────────────────────────────────
    if (sub === 'dm') {
      const enabled = interaction.options.getBoolean('enabled') ?? false;
      const cfg = await WelcomerManager.getConfig(guild.id, 'welcome');

      // Seed a usable default on first enable, so turning it on immediately
      // does something instead of silently sending nothing.
      const dmTemplate = cfg.dmTemplate ?? WelcomerManager.defaultDmTemplate('embed');
      await WelcomerManager.setConfig(guild.id, 'welcome', { dmEnabled: enabled, dmTemplate });

      return interaction.editReply({ ...CB.successResponse(
        enabled ? 'Welcome DMs Enabled' : 'Welcome DMs Disabled',
        enabled
          ? [
            'New members will also receive a private message.',
            cfg.dmTemplate ? '' : 'A starter DM was created for you.',
            'Customise it with `/welcomer dmbuilder`.',
            '-# Members with DMs closed simply won\'t get it — that is normal, not an error.',
            cfg.enabled ? '' : '-# The in-channel welcome is still off; DMs work independently of it.',
          ].filter(Boolean).join('\n')
          : 'New members will no longer be DMed. The DM design is kept for later.',
      ) } as never);
    }

    // ── dm builder ──────────────────────────────────────────────────────────
    if (sub === 'dmbuilder') {
      const cfg = await WelcomerManager.getConfig(guild.id, 'welcome');
      return openBuilder(interaction, {
        target: 'wdm:welcome',
        template: cfg.dmTemplate ?? WelcomerManager.defaultDmTemplate('embed'),
        ownerId: interaction.user.id,
      });
    }

    // ── options ─────────────────────────────────────────────────────────────
    if (sub === 'options') {
      const deleteAfter = interaction.options.getInteger('delete_after');
      if (deleteAfter === null) {
        return interaction.editReply({ ...CB.errorResponse(
          'Nothing to Change', 'Provide `delete_after` (0–3600 seconds, 0 keeps the message).',
        ) } as never);
      }
      await WelcomerManager.setConfig(guild.id, event, { deleteAfter });
      return interaction.editReply({ ...CB.successResponse(
        'Options Updated',
        deleteAfter > 0
          ? `${event === 'welcome' ? 'Welcome' : 'Goodbye'} messages will be deleted after **${deleteAfter}s**.\n-# Useful for keeping busy channels tidy.`
          : `${event === 'welcome' ? 'Welcome' : 'Goodbye'} messages will be kept permanently.`,
      ) } as never);
    }

    // ── style switch ────────────────────────────────────────────────────────
    if (sub === 'style') {
      const style = (interaction.options.getString('style') ?? 'embed') as TemplateStyle;
      if (style !== 'embed' && style !== 'v2') {
        return interaction.editReply({ ...CB.errorResponse('Invalid Style', 'Choose `embed` or `v2`.') } as never);
      }
      const cfg = await WelcomerManager.getConfig(guild.id, event);
      // Only the style key changes — every other field is preserved, which is
      // the point of the unified template model.
      await WelcomerManager.setTemplate(guild.id, event, { ...cfg.template, style });
      return interaction.editReply({ ...CB.successResponse(
        `Style: ${style === 'v2' ? 'Components V2' : 'Embed'}`,
        [
          'Your existing content was kept — only the rendering changed.',
          style === 'v2'
            ? '-# V2 adds multi-image galleries and dividers; it has no inline fields, so those are grouped onto one line.'
            : '-# Embeds add inline fields and a native author row; only the first gallery image is shown.',
          `Preview it with \`/welcomer test event:${event}\`.`,
        ].join('\n'),
      ) } as never);
    }

    // ── test ────────────────────────────────────────────────────────────────
    if (sub === 'test') {
      const cfg = await WelcomerManager.getConfig(guild.id, event);
      if (!isRenderable(cfg.template)) {
        return interaction.editReply({ ...CB.errorResponse(
          'Nothing to Preview', `That message is empty. Set it up with \`/welcomer quick event:${event}\`.`,
        ) } as never);
      }
      // Rendered against the caller, so placeholders resolve to real values.
      const payload = renderTemplate(cfg.template, {
        member: interaction.member as GuildMember, user: interaction.user, guild,
      });

      await interaction.editReply({ ...CB.successResponse(
        `${event === 'welcome' ? 'Welcome' : 'Goodbye'} Preview`,
        [
          `Rendered as **${cfg.template.style === 'v2' ? 'Components V2' : 'an embed'}** using your own account.`,
          cfg.enabled && cfg.channelId ? `Live in <#${cfg.channelId}>.` : '-# Not live yet — see `/welcomer status`.',
        ].join('\n'),
      ) } as never);

      // Delivered as a separate message: this reply was deferred with the V2
      // flag, and a V2 message may not contain embeds — so an embed-style
      // preview cannot be edited into it.
      return interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral } as never);
    }

    // ── builder ─────────────────────────────────────────────────────────────
    if (sub === 'builder') {
      const cfg = await WelcomerManager.getConfig(guild.id, event);
      return openBuilder(interaction, {
        target: `welcomer:${event}`,
        template: cfg.template,
        ownerId: interaction.user.id,
      });
    }

    // ── quick ───────────────────────────────────────────────────────────────
    const channel = interaction.options.getChannel('channel') as TextChannel | null;
    if (!channel) return interaction.editReply({ ...CB.errorResponse('Missing Channel', 'Pick a channel.') } as never);

    const me = guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms?.has(PermissionFlagsBits.SendMessages)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Cannot Post There', `I need **View Channel** and **Send Messages** in ${channel}.`,
      ) } as never);
    }

    const style = (interaction.options.getString('style') ?? 'embed') as TemplateStyle;
    const custom = interaction.options.getString('message');

    const template = WelcomerManager.defaultTemplate(event, style === 'v2' ? 'v2' : 'embed');
    if (custom?.trim()) template.description = custom.trim();

    await WelcomerManager.setConfig(guild.id, event, {
      enabled: true, channelId: channel.id, template,
    });

    await interaction.editReply({
      components: [
        new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# ✅ ${event === 'welcome' ? 'Welcome' : 'Goodbye'} message set`,
          `Posting in ${channel} · style **${style === 'v2' ? 'Components V2' : 'Embed'}**`,
          '',
          describeTemplate(template),
          '',
          `-# Refine it with \`/welcomer builder event:${event}\`, or switch style with \`/welcomer style\`.`,
          '-# Preview below:',
        ].join('\n'))),
      ],
    } as never);

    // Separate message for the same reason as `test` — a V2 reply cannot hold
    // an embed, and the preview's shape depends on the chosen style.
    const preview = renderTemplate(template, {
      member: interaction.member as GuildMember, user: interaction.user, guild,
    });
    return interaction.followUp({ ...preview, flags: MessageFlags.Ephemeral } as never);
  },
});
