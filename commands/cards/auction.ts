import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import CardManager, { effectiveStats } from '../../managers/CardManager';
import { RARITIES } from '../../services/CardService';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import { resolveDisplayName } from '../../utils/UserResolver';

const PER_PAGE = 8;

export default new Command({
  data: new SlashCommandBuilder()
    .setName('auction').setDescription('Buy and sell anime cards on the auction house.')
    .addSubcommand((s) => s.setName('browse').setDescription('See cards for sale')
      .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)))
    .addSubcommand((s) => s.setName('sell').setDescription('List one of your cards for sale')
      .addStringOption((o) => o.setName('card').setDescription('Card name or MAL id').setRequired(true))
      .addStringOption((o) => o.setName('price').setDescription('Asking price, e.g. 5000 or 10k').setRequired(true)))
    .addSubcommand((s) => s.setName('buy').setDescription('Buy a listing')
      .addStringOption((o) => o.setName('listing_id').setDescription('Listing ID from /auction browse').setRequired(true)))
    .addSubcommand((s) => s.setName('cancel').setDescription('Cancel your listing and get the card back')
      .addStringOption((o) => o.setName('listing_id').setDescription('Listing ID').setRequired(true)))
    .addSubcommand((s) => s.setName('mine').setDescription('See your active listings')),
  category: 'cards',
  aliases: ['ah', 'market'],
  cooldown: 3_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['browse', 'sell', 'buy', 'cancel', 'mine'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    // Clear expired listings first so browse/buy never show a stale card.
    await CardManager.expireListings();

    // ── browse / mine ───────────────────────────────────────────────────────
    if (sub === 'browse' || sub === 'mine') {
      const all = await CardManager.getListings();
      const listings = sub === 'mine'
        ? all.filter((l) => l.sellerId === interaction.user.id)
        : all;

      if (!listings.length) {
        return interaction.editReply({ ...CB.successResponse(
          sub === 'mine' ? 'No Listings' : 'Auction House Empty',
          sub === 'mine'
            ? 'You have no cards listed. Use `/auction sell` to list one.'
            : 'Nothing for sale right now. List a card with `/auction sell`.',
        ) } as never);
      }

      const sorted = [...listings].sort((a, b) => a.price - b.price);
      const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
      const page = Math.min(Math.max(1, interaction.options.getInteger('page') ?? 1), totalPages);
      const slice = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE);

      const lines = await Promise.all(slice.map(async (l) => {
        const meta = RARITIES[l.card.rarity] ?? RARITIES.common;
        const s = effectiveStats(l.card);
        const seller = await resolveDisplayName(l.sellerId, { guild: interaction.guild, client: interaction.client });
        return [
          `${meta.emoji} **${l.card.name}** · Lv.${l.card.level ?? 1} · ${meta.label}`,
          `> **${fmt.coins(l.price)}** — ATK ${fmt.number(s.attack)} / HP ${fmt.number(s.health)}`,
          `> -# \`${l.listingId}\` · by ${seller} · ends <t:${Math.floor(l.expiresAt / 1000)}:R>`,
        ].join('\n');
      }));

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `# 🏛️ ${sub === 'mine' ? 'Your Listings' : 'Auction House'}\n**${sorted.length}** card${sorted.length !== 1 ? 's' : ''} listed`,
        ))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `-# Page ${page} of ${totalPages} · \`/auction buy <listing_id>\``,
        ));
      return interaction.editReply({ components: [c] });
    }

    // ── sell ────────────────────────────────────────────────────────────────
    if (sub === 'sell') {
      const query = (interaction.options.getString('card') ?? '').trim();
      const card = await CardManager.findCard(interaction.user.id, query);
      if (!card) {
        return interaction.editReply({ ...CB.errorResponse(
          'Not Found', `You don't own a card matching \`${query}\`.`,
        ) } as never);
      }

      // parseAmount accepts 10k/2.5m shorthand; 'all'/'half' make no sense for
      // a price, so cap the relative base at 0 to reject them.
      const price = fmt.parseAmount(interaction.options.getString('price'), 0);
      if (!price || price <= 0) {
        return interaction.editReply({ ...CB.errorResponse(
          'Invalid Price', 'Give a numeric price, e.g. `5000` or `10k`.',
        ) } as never);
      }

      const result = await CardManager.listCard(interaction.user.id, card.id, price);
      if (!result.ok || !result.listing) {
        return interaction.editReply({ ...CB.errorResponse('Cannot List', result.reason ?? 'Unknown error.') } as never);
      }
      const listing = result.listing;

      return interaction.editReply({ ...CB.successResponse(
        'Card Listed',
        [
          `**${result.listing.card.name}** is up for **${fmt.coins(result.listing.price)}**.`,
          `Listing ID: \`${result.listing.listingId}\``,
          `Expires <t:${Math.floor(result.listing.expiresAt / 1000)}:R>.`,
          '-# The card is held in escrow while listed — cancel to get it back.',
        ].join('\n'),
      ) } as never);
    }

    // ── buy ─────────────────────────────────────────────────────────────────
    if (sub === 'buy') {
      const listingId = (interaction.options.getString('listing_id') ?? '').trim();
      const result = await CardManager.buyListing(interaction.user.id, listingId);
      if (!result.ok || !result.listing) {
        return interaction.editReply({ ...CB.errorResponse('Purchase Failed', result.reason ?? 'Unknown error.') } as never);
      }
      const bought = result.listing;
      const meta = RARITIES[bought.card.rarity] ?? RARITIES.common;
      return interaction.editReply({ ...CB.successResponse(
        'Card Purchased',
        [
          `You bought ${meta.emoji} **${result.listing.card.name}** (Lv.${result.listing.card.level ?? 1}) for **${fmt.coins(result.listing.price)}**.`,
          '-# Added to your collection — `/collection` to view it.',
        ].join('\n'),
      ) } as never);
    }

    // ── cancel ──────────────────────────────────────────────────────────────
    const listingId = (interaction.options.getString('listing_id') ?? '').trim();
    const result = await CardManager.cancelListing(interaction.user.id, listingId);
    if (!result.ok || !result.card) {
      return interaction.editReply({ ...CB.errorResponse('Cannot Cancel', result.reason ?? 'Unknown error.') } as never);
    }
    return interaction.editReply({ ...CB.successResponse(
      'Listing Cancelled', `**${result.card.name}** is back in your collection.`,
    ) } as never);
  },
});
