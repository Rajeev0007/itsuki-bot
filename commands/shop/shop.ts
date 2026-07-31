import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';
import { getStore } from '../../database/JsonStore';

const inventoryDB = getStore('inventory');

export default new Command({
  data: new SlashCommandBuilder()
    .setName('shop').setDescription('Browse the item shop.')
    .addSubcommand((s) => s.setName('browse').setDescription('Browse all items'))
    .addSubcommand((s) => s.setName('buy').setDescription('Buy an item')
      .addStringOption((o) => o.setName('item').setDescription('Item ID').setRequired(true))
      .addIntegerOption((o) => o.setName('quantity').setDescription('Quantity').setMinValue(1).setMaxValue(99))),
  category: 'shop', cooldown: 3000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    if (sub === 'browse') {
      const items = config.shop.items;
      const categories = [...new Set(items.map((i) => i.category))];
      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# Item Shop'));
      container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true));
      for (const cat of categories) {
        const catItems = items.filter((i) => i.category === cat);
        const lines = catItems.map((item) => `> **${item.name}** — ${fmt.coins(item.price)}\n> ${item.description} \`ID: ${item.id}\``);
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent([`**${cat.toUpperCase()}**`, ...lines].join('\n\n')));
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true));
      }
      container.addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Use `/shop buy <item_id>` to purchase'));
      return interaction.editReply({ components: [container] });
    }
    if (sub === 'buy') {
      const rawItem = interaction.options.getString('item');
      if (!rawItem) return interaction.editReply({ ...CB.errorResponse('Missing Item', 'Provide an item ID, e.g. `/shop buy pickaxe`.') } as never);
      const itemId = rawItem.trim().toLowerCase();
      const qty = Math.max(1, Math.min(99, interaction.options.getInteger('quantity') ?? 1));
      const item = config.shop.items.find((i) => i.id === itemId);
      if (!item) return interaction.editReply({ ...CB.errorResponse('Not Found', `No item with ID \`${itemId}\`.`) } as never);
      const totalCost = item.price * qty;
      const { wallet } = await UserManager.getBalance(interaction.user.id);
      if (wallet < totalCost) return interaction.editReply({ ...CB.errorResponse('Insufficient Funds', `You need ${fmt.coins(totalCost)} but only have ${fmt.coins(wallet)}.`) } as never);
      await UserManager.addWallet(interaction.user.id, -totalCost);
      await inventoryDB.ensure(interaction.user.id, {});
      const key = `${interaction.user.id}.${item.id}`;
      await inventoryDB.ensure(key, 0);
      await inventoryDB.add(key, qty);
      await UserManager.recordTransaction(interaction.user.id, 'shop_purchase', -totalCost, `${item.name} x${qty}`);
      const eco = await UserManager.getEconomy(interaction.user.id);
      const current = await inventoryDB.get(key) as number;
      const c = new ContainerBuilder()
        .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([`# Purchase Successful!`, `You bought **${item.name} x${qty}** for ${fmt.coins(totalCost)}!`].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**${item.name}:** ${current}x in inventory`,
          `${E.WALLET} **Remaining wallet:** ${fmt.coins(eco.wallet)}`,
        ].join('\n')));
      return interaction.editReply({ components: [c] });
    }
  },
});
