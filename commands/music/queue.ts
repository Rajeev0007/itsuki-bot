import {
  SlashCommandBuilder, ContainerBuilder, TextDisplayBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }        from '../../structures/Command';
import music              from '../../managers/MusicManager';
import { musicCheck, musicError, formatDuration } from '../../utils/MusicUtil';
import type { GuildSession } from '../../managers/MusicManager';

const PAGE_SIZE = 10;

export function buildQueuePage(session: GuildSession, page: number): { components: unknown[]; flags: number } {
  const total  = session.queueList.length;
  const pages  = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePg = Math.min(Math.max(1, page), pages);
  const start  = (safePg - 1) * PAGE_SIZE;
  const slice  = session.queueList.slice(start, start + PAGE_SIZE);
  const lines: string[] = [];

  if (session.current) {
    const info = (session.current.info ?? {}) as { title?: string; uri?: string; length?: number; isStream?: boolean };
    const dur  = info.isStream ? 'LIVE' : formatDuration(info.length ?? 0);
    const req  = session.current.requester;
    lines.push('**▶ Now Playing**');
    lines.push(`> **[${info.title ?? 'Unknown'}](${info.uri ?? '#'})** \`[${dur}]\``);
    lines.push(`> -# Requested by ${req?.displayName ?? req?.username ?? 'Unknown'}`);
    lines.push('');
  }

  if (slice.length === 0 && !session.current) {
    lines.push('*The queue is empty.*');
  } else if (slice.length > 0) {
    lines.push(`**Up next — Page ${safePg}/${pages}**`);
    let totalDurMs = 0;
    for (const t of session.queueList) totalDurMs += (t.info as { length?: number })?.length ?? 0;
    for (let i = 0; i < slice.length; i++) {
      const info = (slice[i].info ?? {}) as { title?: string; length?: number; isStream?: boolean };
      const dur  = info.isStream ? 'LIVE' : formatDuration(info.length ?? 0);
      const req  = slice[i].requester;
      lines.push(`\`${start + i + 1}.\` **${info.title ?? 'Unknown'}** \`[${dur}]\` — ${req?.displayName ?? req?.username ?? 'Unknown'}`);
    }
    lines.push('');
    lines.push(`-# ${total} track${total !== 1 ? 's' : ''} • Total: \`${formatDuration(totalDurMs)}\` • Loop: **${session.loop}**`);
  }

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n')));

  const components: unknown[] = [container];

  if (pages > 1) {
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`music_qpage:${session.voiceChannel.guild.id}:${safePg - 1}`)
        .setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(safePg <= 1),
      new ButtonBuilder()
        .setCustomId('music_qpage_display').setLabel(`${safePg} / ${pages}`)
        .setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder()
        .setCustomId(`music_qpage:${session.voiceChannel.guild.id}:${safePg + 1}`)
        .setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(safePg >= pages),
    );
    components.push(navRow);
  }

  return { components, flags: MessageFlags.IsComponentsV2 as any };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Show the current song queue.')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)),
  category: 'music',
  // Voice playback needs a guild voice channel — not available in DMs.
  guildOnly: true,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { error, session } = musicCheck(interaction, music, { needsQueue: true });
    if (error) return interaction.editReply(musicError(error) as never);
    const page = interaction.options.get('page')?.value as number ?? 1;
    return interaction.editReply(buildQueuePage(session!, page) as never);
  },
});
