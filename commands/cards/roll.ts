import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, AttachmentBuilder, MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ChatInputCommandInteraction, type ButtonInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import CardManager from '../../managers/CardManager';
import CardService, { RARITIES } from '../../services/CardService';
import { renderCard } from '../../services/CardCanvas';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import logger from '../../utils/Logger';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('roll').setDescription('Roll a random anime character card — first to claim it keeps it!'),
  category: 'cards',
  aliases: ['w', 'draw'],
  cooldown: 3_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const userId = interaction.user.id;

    const remaining = await CardManager.getRollCooldown(userId);
    if (remaining > 0) {
      return interaction.editReply({ ...CB.errorResponse(
        'Slow Down',
        `You can roll again in **${fmt.duration(remaining)}**.`,
      ) } as never);
    }

    const template = await CardService.randomCard();
    if (!template) {
      return interaction.editReply({ ...CB.errorResponse(
        'Card Source Unavailable',
        'Could not reach the character database (MyAnimeList). Try again in a moment.',
      ) } as never);
    }

    await CardManager.markRolled(userId);

    const meta = RARITIES[template.rarity];
    // A rolled card is not owned yet, so present it at level 1 with no copies.
    const preview = {
      ...template, level: 1, copies: 0, claimedAt: Date.now(),
    };

    const claimId = `card_claim:${template.id}:${userId}:${Date.now().toString(36)}`;
    const claimRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(claimId).setLabel('Claim').setStyle(ButtonStyle.Success).setEmoji('🎴'),
    );

    const header = [
      `# ${meta.emoji} ${template.name}`,
      template.animeName ? `-# ${template.animeName}` : '',
      `**${meta.label}** · ATK ${fmt.number(template.baseAttack)} · HP ${fmt.number(template.baseHealth)}`,
      `-# ${fmt.number(template.favorites)} MAL favourites · first to claim keeps it`,
    ].filter(Boolean).join('\n');

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(header));

    // Try the rendered card; fall back to the raw artwork so a canvas failure
    // never blocks a roll.
    let files: AttachmentBuilder[] = [];
    try {
      const png = await renderCard(preview);
      files = [new AttachmentBuilder(png, { name: 'card.png' })];
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://card.png')),
      );
    } catch (err) {
      logger.warn(`[roll] Card render failed, using raw artwork: ${(err as Error).message}`);
      container.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(template.imageUrl)),
      );
    }

    container
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `-# Claimable for ${Math.round(config.cards.claimWindow / 1000)}s`,
      ))
      .addActionRowComponents(claimRow);

    const msg = await interaction.editReply({ components: [container], files } as never);

    // ── Claim race ───────────────────────────────────────────────────────────
    // Anyone may claim, first click wins. `claimed` is set synchronously inside
    // the collect handler before any await, so two near-simultaneous clicks
    // cannot both succeed.
    let claimed = false;

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: { filter: (i: ButtonInteraction) => boolean; time: number }) =>
        { on: (e: string, cb: (...a: never[]) => void) => void; stop: () => void };
    }).createMessageComponentCollector({
      filter: (i) => i.customId === claimId,
      time: config.cards.claimWindow,
    });

    collector.on('collect', async (i: ButtonInteraction) => {
      if (claimed) {
        await i.reply({ content: 'Too late — someone already claimed this card.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      claimed = true;
      collector.stop();

      const { card, isDuplicate } = await CardManager.addCard(i.user.id, template);

      const claimedBy = [
        `# ${meta.emoji} Claimed by ${i.user.username}`,
        template.animeName ? `-# ${template.animeName}` : '',
        `**${card.name}** — ${meta.label}`,
        isDuplicate
          ? `-# Duplicate! You now have **${card.copies + 1}** copies — use them to halve upgrade costs.`
          : `-# Added to your collection. \`/collection\` to view it.`,
      ].filter(Boolean).join('\n');

      const done = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(claimedBy));
      done.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(
          files.length ? 'attachment://card.png' : template.imageUrl,
        )),
      );

      await i.update({ components: [done] } as never).catch(() => {});
    });

    collector.on('end', async () => {
      if (claimed) return;
      // Nobody claimed — disable the button so it doesn't look interactive.
      const expiredRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(claimId).setLabel('Claim expired').setStyle(ButtonStyle.Secondary).setDisabled(true),
      );
      const expired = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          `${header}\n\n-# Nobody claimed this card.`,
        ));
      expired.addMediaGalleryComponents(
        new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(
          files.length ? 'attachment://card.png' : template.imageUrl,
        )),
      );
      expired.addActionRowComponents(expiredRow);
      await interaction.editReply({ components: [expired] } as never).catch(() => {});
    });
  },
});
