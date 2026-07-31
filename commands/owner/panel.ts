/**
 * @file panel.ts
 * @description Owner-only live control panel, driven entirely from Discord.
 *
 * The point of this is that nothing here requires editing a config file or
 * restarting the process: presence, status, custom status, maintenance mode and
 * cache management are all applied immediately and persisted so they survive a
 * restart.
 *
 * View state is encoded in the customIds (`panel_<action>:<ownerId>:…`) so the
 * panel keeps working after a restart, rather than relying on an in-memory
 * collector that dies with the process.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder,
  type ChatInputCommandInteraction, type Client,
} from 'discord.js';
import { Command } from '../../structures/Command';
import PresenceManager, { ACTIVITY_TYPES, STATUS_CHOICES } from '../../managers/PresenceManager';
import MaintenanceManager from '../../managers/MaintenanceManager';
import BlacklistManager from '../../managers/BlacklistManager';
import NoPrefixManager from '../../managers/NoPrefixManager';
import config from '../../config/config';
import fmt from '../../utils/Formatter';

export type PanelView = 'home' | 'presence' | 'system' | 'guilds';

const VIEWS: Array<{ id: PanelView; label: string; description: string }> = [
  { id: 'home',     label: 'Overview',   description: 'Bot health at a glance' },
  { id: 'presence', label: 'Presence',   description: 'Status, activity and custom status' },
  { id: 'system',   label: 'System',     description: 'Memory, cache and maintenance' },
  { id: 'guilds',   label: 'Servers',    description: 'Where the bot is installed' },
];

function uptime(): string {
  return fmt.duration(process.uptime() * 1000);
}

function memoryMb(): string {
  return `${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)} MB`;
}

function navRow(current: PanelView, ownerId: string): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`panel_nav:${ownerId}`)
      .setPlaceholder('Jump to…')
      .addOptions(VIEWS.map((v) => ({
        label: v.label, description: v.description, value: v.id, default: v.id === current,
      }))),
  );
}

/**
 * Renders a panel view.
 *
 * Exported so every button, select menu and modal rebuilds the panel through
 * exactly this function — the panel can't drift between entry points.
 */
export function buildPanel(view: PanelView, ownerId: string, client: Client): { components: ContainerBuilder[] } {
  const container = new ContainerBuilder();
  const presence = PresenceManager.getState();

  if (view === 'presence') {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# 🎛️ Presence',
      `**Mode:** ${presence.mode === 'custom' ? 'Custom (fixed)' : 'Rotating presets'}`,
      `**Showing:** ${PresenceManager.describe()}`,
      `**Status:** ${STATUS_CHOICES.find((s) => s.id === presence.status)?.label ?? presence.status}`,
      presence.activityType === 'streaming'
        ? `**Stream URL:** ${presence.streamUrl ?? '*not set — Streaming needs a Twitch/YouTube URL*'}`
        : '',
      '',
      '-# Changes apply instantly and survive a restart.',
    ].filter(Boolean).join('\n')));

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));

    // Status picker — works in both modes.
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`panel_status:${ownerId}`)
          .setPlaceholder('Online status…')
          .addOptions(STATUS_CHOICES.map((s) => ({
            label: s.label, value: s.id, default: s.id === presence.status,
          }))),
      ),
    );

    // Activity type picker — selecting one switches to custom mode.
    container.addActionRowComponents(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`panel_acttype:${ownerId}`)
          .setPlaceholder('Activity type…')
          .addOptions(ACTIVITY_TYPES.map((t) => ({
            label: t.label, value: t.id, default: t.id === presence.activityType,
          }))),
      ),
    );

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`panel_settext:${ownerId}`)
          .setLabel('Set activity text').setStyle(ButtonStyle.Primary).setEmoji('✏️'),
        new ButtonBuilder().setCustomId(`panel_rotate:${ownerId}`)
          .setLabel('Resume rotation').setStyle(ButtonStyle.Secondary)
          .setDisabled(presence.mode === 'rotate'),
        new ButtonBuilder().setCustomId(`panel_refresh:presence:${ownerId}`)
          .setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
      ),
    );
    container.addActionRowComponents(navRow(view, ownerId));
    return { components: [container] };
  }

  if (view === 'system') {
    const maint = MaintenanceManager.isEnabled();
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# 🖥️ System',
      `**Memory:** ${memoryMb()}`,
      `**Uptime:** ${uptime()}`,
      `**Node:** ${process.version}`,
      `**WS ping:** ${client.ws.ping}ms`,
      '',
      `**Maintenance:** ${maint ? '🔴 ON' : '🟢 OFF'}`,
      maint && MaintenanceManager.reason() ? `> ${MaintenanceManager.reason()}` : '',
      '',
      `**Cached:** ${client.users.cache.size} users · ${client.channels.cache.size} channels`,
      `**Blacklisted:** ${BlacklistManager.count()} · **NoPrefix:** ${NoPrefixManager.count()}`,
    ].filter(Boolean).join('\n')));

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`panel_maint:${maint ? 'off' : 'on'}:${ownerId}`)
            .setLabel(maint ? 'Disable maintenance' : 'Enable maintenance')
            .setStyle(maint ? ButtonStyle.Success : ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`panel_backup:${ownerId}`)
            .setLabel('Backup databases').setStyle(ButtonStyle.Secondary).setEmoji('💾'),
          new ButtonBuilder().setCustomId(`panel_refresh:system:${ownerId}`)
            .setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
        ),
      )
      .addActionRowComponents(navRow(view, ownerId));
    return { components: [container] };
  }

  if (view === 'guilds') {
    // Largest first — the ones that matter operationally.
    const guilds = [...client.guilds.cache.values()]
      .sort((a, b) => (b.memberCount ?? 0) - (a.memberCount ?? 0))
      .slice(0, 15);

    const lines = guilds.length
      ? guilds.map((g, i) =>
          `\`${String(i + 1).padStart(2)}\` **${g.name}** — ${fmt.number(g.memberCount ?? 0)} members\n> -# \`${g.id}\``)
      : ['-# No guilds cached.'];

    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# 🌐 Servers',
      `In **${client.guilds.cache.size}** server(s), reaching **${fmt.number(
        client.guilds.cache.reduce((sum, g) => sum + (g.memberCount ?? 0), 0),
      )}** members.`,
    ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

    if (client.guilds.cache.size > guilds.length) {
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# Showing the ${guilds.length} largest of ${client.guilds.cache.size}.`,
      ));
    }
    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`panel_refresh:guilds:${ownerId}`)
          .setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
      ),
    )
      .addActionRowComponents(navRow(view, ownerId));
    return { components: [container] };
  }

  // ── home ─────────────────────────────────────────────────────────────────
  const commandCount = (client as unknown as { commands?: Map<string, unknown> }).commands?.size ?? 0;
  container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    `# 🎛️ ${config.bot.name} Control Panel`,
    '-# Owner only · everything here applies live',
  ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `**Servers:** ${client.guilds.cache.size}`,
      `**Commands loaded:** ${commandCount}`,
      `**Uptime:** ${uptime()}`,
      `**Memory:** ${memoryMb()}`,
      `**WS ping:** ${client.ws.ping}ms`,
      '',
      `**Presence:** ${PresenceManager.describe()}`,
      `**Status:** ${STATUS_CHOICES.find((s) => s.id === PresenceManager.getState().status)?.label ?? '—'}`,
      `**Maintenance:** ${MaintenanceManager.isEnabled() ? '🔴 ON' : '🟢 OFF'}`,
    ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(
      '-# Use the menu below to manage presence, system settings and servers.',
    ))
    .addActionRowComponents(navRow('home', ownerId));

  return { components: [container] };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('panel').setDescription('(Owner) Live control panel for the bot.')
    .addStringOption((o) => o.setName('view').setDescription('Open a specific section')
      .addChoices(...VIEWS.map((v) => ({ name: v.label, value: v.id })))),
  category: 'owner',
  ownerOnly: true,
  aliases: ['botpanel', 'dashboard'],
  cooldown: 0,

  async execute(interaction: ChatInputCommandInteraction, client?: Client) {
    // Ephemeral: the panel exposes operational detail and control buttons, so it
    // shouldn't sit in channel history for others to see.
    await interaction.deferReply({
      flags: (MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral) as never,
    });

    const view = (interaction.options.getString('view') ?? 'home') as PanelView;
    const resolved = VIEWS.some((v) => v.id === view) ? view : 'home';

    await interaction.editReply(
      buildPanel(resolved, interaction.user.id, client ?? interaction.client) as never,
    );
  },
});
