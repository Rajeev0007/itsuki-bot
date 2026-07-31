import {
  MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ButtonInteraction,
} from 'discord.js';
import AnimeService from '../../services/AnimeService';
import * as CB       from '../../builders/ComponentBuilder';

export const customId = 'waifu_reroll:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const [, ownerId, rawCategory] = interaction.customId.split(':');

  if (ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'This button is not for you.', flags: MessageFlags.Ephemeral });
    return;
  }

  // A malformed/legacy customId leaves this undefined, and `category.charAt(0)`
  // below would throw. Fall back to the default category instead.
  const category = rawCategory && AnimeService.isValidWaifuCategory(rawCategory) ? rawCategory : 'waifu';

  await interaction.deferUpdate();

  const imageUrl = await AnimeService.getWaifuImage(category);
  if (!imageUrl) {
    await interaction.followUp({ content: 'Could not fetch a new image. Try again.', flags: MessageFlags.Ephemeral });
    return;
  }

  const c = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ${category.charAt(0).toUpperCase() + category.slice(1)}`))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addMediaGalleryComponents(CB.gallery(imageUrl))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Requested by ${interaction.user.username}`))
    .addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`waifu_reroll:${interaction.user.id}:${category}`).setLabel('Reroll').setStyle(ButtonStyle.Secondary),
      ),
    );

  await interaction.editReply({ components: [c] });
}
