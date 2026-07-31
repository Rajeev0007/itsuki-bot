import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }  from '../../structures/Command';
import * as CB      from '../../builders/ComponentBuilder';
import config       from '../../config/config';
import { getStore } from '../../database/Store';

const inventoryDB = getStore('inventory');

export default new Command({
  data: new SlashCommandBuilder()
    .setName('inventory').setDescription('View your item inventory.')
    .addUserOption((o) => o.setName('user').setDescription('User whose inventory to view')),
  category: 'inventory', cooldown: 3000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const target = interaction.options.get('user')?.user ?? interaction.user;
    const inv    = (await inventoryDB.get(target.id)) as Record<string, number> | null;
    if (!inv || Object.keys(inv).length === 0)
      return interaction.editReply({ ...CB.errorResponse('Empty Inventory', target.id === interaction.user.id ? 'You have no items yet. Visit `/shop browse` to buy some!' : `${target.username} has no items.`) } as never);
    const shopItems = config.shop.items;
    const lines = Object.entries(inv).filter(([, qty]) => qty > 0).map(([id, qty]) => {
      const item = shopItems.find((i) => i.id === id);
      if (!item) return `> **${id}** x${qty}`;
      return `> **${item.name}** — x${qty}\n> *${item.description}*`;
    });
    if (!lines.length) return interaction.editReply({ ...CB.errorResponse('Empty', 'Inventory is empty.') } as never);
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`# ${target.username}'s Inventory`)
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(target.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${lines.length} unique item(s)`));
    await interaction.editReply({ components: [c] });
  },
});
