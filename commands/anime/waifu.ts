import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import AnimeService from '../../services/AnimeService';
import * as CB from '../../builders/ComponentBuilder';

const CATS = ['waifu','neko','shinobu','megumin','cuddle','cry','hug','kiss','pat','smug','bonk','blush','smile','wave','dance'];

export default new Command({
  data: new SlashCommandBuilder()
    .setName('waifu').setDescription('Fetch a random anime image.')
    .addStringOption((o) => o.setName('category').setDescription('Image category')
      .addChoices(...CATS.map((c) => ({ name: c, value: c })))),
  category: 'anime', cooldown: 3000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const category = (interaction.options.get('category')?.value as string) ?? 'waifu';
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
