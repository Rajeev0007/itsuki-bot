import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, AttachmentBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import CardManager, { effectiveStats, upgradeCost, MAX_CARD_LEVEL } from '../../managers/CardManager';
import { RARITIES } from '../../services/CardService';
import { renderCard } from '../../services/CardCanvas';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('card').setDescription('Inspect, flex or lock a card you own.')
    .addSubcommand((s) => s.setName('view').setDescription('Show a card in full')
      .addStringOption((o) => o.setName('name').setDescription('Card name or MAL id').setRequired(true))
      .addUserOption((o) => o.setName('owner').setDescription('Whose card to view (defaults to you)')))
    .addSubcommand((s) => s.setName('lock').setDescription('Protect a card from being sold')
      .addStringOption((o) => o.setName('name').setDescription('Card name or MAL id').setRequired(true)))
    .addSubcommand((s) => s.setName('unlock').setDescription('Allow a card to be sold again')
      .addStringOption((o) => o.setName('name').setDescription('Card name or MAL id').setRequired(true))),
  category: 'cards',
  cooldown: 3_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['view', 'lock', 'unlock'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    const query = (interaction.options.getString('name') ?? '').trim();
    if (!query) {
      return interaction.editReply({ ...CB.errorResponse('Missing Card', 'Give a card name or MAL id.') } as never);
    }

    const owner = sub === 'view'
      ? (interaction.options.getUser('owner') ?? interaction.user)
      : interaction.user;

    const card = await CardManager.findCard(owner.id, query);
    if (!card) {
      return interaction.editReply({ ...CB.errorResponse(
        'Not Found',
        owner.id === interaction.user.id
          ? `You don't own a card matching \`${query}\`. Check \`/collection\`.`
          : `**${owner.username}** doesn't own a card matching \`${query}\`.`,
      ) } as never);
    }

    if (sub === 'lock' || sub === 'unlock') {
      const locked = sub === 'lock';
      await CardManager.setLocked(interaction.user.id, card.id, locked);
      return interaction.editReply({ ...CB.successResponse(
        locked ? 'Card Locked' : 'Card Unlocked',
        locked
          ? `**${card.name}** is protected — it can't be auctioned until you unlock it.`
          : `**${card.name}** can be auctioned again.`,
      ) } as never);
    }

    // ── view ────────────────────────────────────────────────────────────────
    const meta = RARITIES[card.rarity] ?? RARITIES.common;
    const stats = effectiveStats(card);
    const atMax = (card.level ?? 1) >= MAX_CARD_LEVEL;

    const details = [
      `# ${meta.emoji} ${card.name}`,
      card.animeName ? `-# ${card.animeName}` : '',
      `**${meta.label}** · Level **${card.level ?? 1}** / ${MAX_CARD_LEVEL}`,
      '',
      `**ATK** ${fmt.number(stats.attack)}  ·  **HP** ${fmt.number(stats.health)}  ·  **Power** ${fmt.number(stats.power)}`,
      `-# MAL #${card.id} · ${fmt.number(card.favorites)} favourites${(card.copies ?? 0) > 0 ? ` · ${card.copies + 1} copies` : ''}${card.locked ? ' · 🔒 locked' : ''}`,
    ].filter(Boolean).join('\n');

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(details));

    const files: AttachmentBuilder[] = [];
    try {
      const png = await renderCard(card);
      files.push(new AttachmentBuilder(png, { name: 'card.png' }));
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://card.png')),
      );
    } catch (err) {
      logger.warn(`[card view] Render failed, using raw artwork: ${(err as Error).message}`);
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(card.imageUrl)),
      );
    }

    container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        atMax
          ? '-# This card is fully upgraded.'
          : `-# Next upgrade: **${fmt.coins(upgradeCost(card))}**${(card.copies ?? 0) > 0 ? ' (halved — you have a spare copy)' : ''} · \`/upgrade\``,
      ));

    await interaction.editReply({ components: [container], files } as never);
  },
});
