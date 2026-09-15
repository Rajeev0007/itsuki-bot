import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import { Minecraft, GameApiError } from '../../services/GameApiService';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

/** Turns a thrown error into a user-facing response. */
function explain(err: unknown): { title: string; body: string } {
  if (err instanceof GameApiError) {
    return {
      title: err.kind === 'not_found' ? 'Not Found' : 'Lookup Failed',
      body: err.message,
    };
  }
  logger.warn(`[minecraft] Unexpected: ${(err as Error).message}`);
  return { title: 'Lookup Failed', body: 'Something went wrong reaching the Minecraft APIs.' };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('minecraft').setDescription('Minecraft player and server lookups.')
    .addSubcommand((s) => s.setName('player').setDescription('Look up a player and their skin')
      .addStringOption((o) => o.setName('username').setDescription('Minecraft username').setRequired(true)))
    .addSubcommand((s) => s.setName('server').setDescription('Check a server\'s status')
      .addStringOption((o) => o.setName('address').setDescription('e.g. mc.hypixel.net').setRequired(true))),
  category: 'gaming',
  aliases: ['mc'],
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['player', 'server'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', 'Use `/minecraft player` or `/minecraft server`.',
      ) } as never);
    }

    // ── player ──────────────────────────────────────────────────────────────
    if (sub === 'player') {
      const username = (interaction.options.getString('username') ?? '').trim();
      try {
        const p = await Minecraft.getProfile(username);

        const container = new ContainerBuilder()
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                `# ⛏️ ${p.name}`,
                '-# Java Edition profile',
              ].join('\n')))
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(p.avatarUrl)),
          )
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent([
            `**UUID:** \`${p.uuidDashed}\``,
            `**Short:** \`${p.uuid}\``,
          ].join('\n')))
          .addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(p.bodyUrl)),
          )
          .addActionRowComponents(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setLabel('Download skin').setStyle(ButtonStyle.Link).setURL(p.skinUrl),
              new ButtonBuilder().setLabel('NameMC').setStyle(ButtonStyle.Link)
                .setURL(`https://namemc.com/profile/${p.uuid}`),
            ),
          );

        return interaction.editReply({ components: [container] });
      } catch (err) {
        const { title, body } = explain(err);
        return interaction.editReply({ ...CB.errorResponse(title, body) } as never);
      }
    }

    // ── server ──────────────────────────────────────────────────────────────
    const address = (interaction.options.getString('address') ?? '').trim();
    try {
      const s = await Minecraft.getServer(address);

      if (!s.online) {
        return interaction.editReply({ ...CB.errorResponse(
          'Server Offline',
          `**${address}** is offline or unreachable.\n-# Double-check the address, and note some servers block status pings.`,
        ) } as never);
      }

      const pct = s.playersMax > 0 ? Math.round((s.playersOnline / s.playersMax) * 100) : 0;
      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# 🟢 ${s.host}`,
          '-# Server is online',
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          s.motd ? `\`\`\`\n${s.motd.slice(0, 300)}\n\`\`\`` : '',
          `**Players:** ${fmt.number(s.playersOnline)} / ${fmt.number(s.playersMax)} (${pct}%)`,
          `**Version:** ${s.version ?? 'Unknown'}`,
          s.software ? `**Software:** ${s.software}` : '',
          s.port ? `**Port:** ${s.port}` : '',
        ].filter(Boolean).join('\n')));

      return interaction.editReply({ components: [container] });
    } catch (err) {
      const { title, body } = explain(err);
      return interaction.editReply({ ...CB.errorResponse(title, body) } as never);
    }
  },
});
