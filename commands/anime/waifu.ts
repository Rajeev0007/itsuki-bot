import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import AnimeService, { WAIFU_CATEGORIES } from '../../services/AnimeService';
import * as CB from '../../builders/ComponentBuilder';

// Slash choices cap at 25; the category list is the service's, so the two can't
// drift apart and offer something the API rejects.
const CATS = WAIFU_CATEGORIES.slice(0, 25);

export default new Command({
  data: new SlashCommandBuilder()
    .setName('waifu').setDescription('Fetch a random anime image.')
    .addStringOption((o) => o.setName('category').setDescription('Image category')
      .addChoices(...CATS.map((c) => ({ name: c, value: c })))),
  category: 'anime', cooldown: 3000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const requested = (interaction.options.getString('category') ?? 'waifu').trim().toLowerCase();

    // Prefix users aren't constrained by slash choices, so an unknown category
    // has to be rejected explicitly. The service silently falls back to 'waifu',
    // which meant the heading announced a category that wasn't what was shown.
    if (!AnimeService.isValidWaifuCategory(requested)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Category',
        `\`${requested}\` isn't a valid category. Try one of: ${CATS.slice(0, 12).map((c) => `\`${c}\``).join(', ')}…`,
      ) } as never);
    }

    const category = requested;
    const imageUrl = await AnimeService.getWaifuImage(category);
    if (!imageUrl) return interaction.editReply({ ...CB.errorResponse('Failed', 'Could not fetch an image. Try again.') } as never);
    const c = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${category.charAt(0).toUpperCase() + category.slice(1)}`))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addMediaGalleryComponents(CB.gallery(imageUrl))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Requested by ${interaction.user.username}`));
    c.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`waifu_reroll:${interaction.user.id}:${category}`).setLabel('Reroll').setStyle(ButtonStyle.Secondary),
      ),
    );
    await interaction.editReply({ components: [c] });
  },
});
