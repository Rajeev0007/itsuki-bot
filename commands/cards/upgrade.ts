import {
  SlashCommandBuilder, MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import CardManager, { effectiveStats, upgradeCost, MAX_CARD_LEVEL } from '../../managers/CardManager';
import { RARITIES } from '../../services/CardService';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('upgrade').setDescription('Spend coins to level up one of your cards.')
    .addStringOption((o) => o.setName('name').setDescription('Card name or MAL id').setRequired(true)),
  category: 'cards',
  cooldown: 3_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const query = (interaction.options.getString('name') ?? '').trim();
    if (!query) {
      return interaction.editReply({ ...CB.errorResponse('Missing Card', 'Give a card name or MAL id to upgrade.') } as never);
    }

    const card = await CardManager.findCard(interaction.user.id, query);
    if (!card) {
      return interaction.editReply({ ...CB.errorResponse(
        'Not Found', `You don't own a card matching \`${query}\`. Check \`/collection\`.`,
      ) } as never);
    }

    const before = effectiveStats(card);
    const cost   = upgradeCost(card);

    const result = await CardManager.upgrade(interaction.user.id, card.id);
    if (!result.ok || !result.card) {
      return interaction.editReply({ ...CB.errorResponse('Upgrade Failed', result.reason ?? 'Unknown error.') } as never);
    }

    const upgraded = result.card;
    const after = effectiveStats(upgraded);
    const meta  = RARITIES[upgraded.rarity] ?? RARITIES.common;
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const atMax = (result.card.level ?? 1) >= MAX_CARD_LEVEL;

    return interaction.editReply({ ...CB.successResponse(
      `${meta.emoji} ${result.card.name} — Level ${result.card.level}`,
      [
        `**ATK** ${fmt.number(before.attack)} → **${fmt.number(after.attack)}**`,
        `**HP** ${fmt.number(before.health)} → **${fmt.number(after.health)}**`,
        `**Power** ${fmt.number(before.power)} → **${fmt.number(after.power)}**`,
        '',
        `Cost: **${fmt.coins(result.cost)}**${result.usedCopy ? ' — halved by consuming a duplicate copy' : ''}`,
        `${'\u200b'}Wallet: **${fmt.coins(wallet)}**`,
        atMax
          ? '-# Fully upgraded.'
          : `-# Next level costs **${fmt.coins(upgradeCost(result.card))}**.`,
      ].join('\n'),
    ) } as never);
  },
});
