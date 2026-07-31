import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import fmt from '../../utils/Formatter';
import PB from '../../utils/ProgressBar';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('balance').setDescription('Check your wallet and bank balance.')
    .addUserOption((o) => o.setName('user').setDescription("Check another user's balance.")),
  category: 'economy',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const target = interaction.options.get('user')?.user ?? interaction.user;
    const isSelf = target.id === interaction.user.id;
    const [eco, user] = await Promise.all([UserManager.getEconomy(target.id), UserManager.getUser(target.id, interaction.guild?.id)]);
    const bankPct = eco.bank / config.economy.bankLimit;
    const bankBar = PB.bar(eco.bank, config.economy.bankLimit, 10);
    const netWorth = eco.wallet + eco.bank;
    const rank = await UserManager.getRank(target.id);
    const prestigePct = (user.prestige ?? 0) * config.economy.prestigeBonus * 100;

    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([
            `# ${E.WALLET} ${isSelf ? 'Your Balance' : `${target.username}'s Balance`}`,
            `${target} • Level **${user.level}** • Prestige **${user.prestige ?? 0}**`,
          ].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(target.displayAvatarURL({ size: 256 })))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.WALLET} **Wallet**`, `> ${fmt.coins(eco.wallet)}`, '',
        `${E.BANK} **Bank** ${bankBar} \`${Math.round(bankPct * 100)}%\``,
        `> ${fmt.coins(eco.bank)} / ${fmt.coins(config.economy.bankLimit)}`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.CHART} **Net Worth:** ${fmt.coins(netWorth)}`,
        `${E.TROPHY} **Leaderboard Rank:** ${rank ? `#${rank}` : 'Unranked'}`,
        `${E.SPARKLES} **Prestige Bonus:** +${prestigePct.toFixed(0)}% earnings`,
        `${E.LIGHTNING} **Total Earned:** ${fmt.coins(eco.totalEarned ?? 0)}`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# Use \`/deposit\` to move coins to your bank | \`/daily\` for free rewards`));

    container.addActionRowComponents(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`balance_deposit:${target.id}`).setLabel('Deposit').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`balance_withdraw:${target.id}`).setLabel('Withdraw').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`balance_refresh:${target.id}`).setLabel('Refresh').setStyle(ButtonStyle.Secondary),
      ),
    );
    await interaction.editReply({ components: [container] });
    // Credit the person who ran the command, not the person being looked at —
    // otherwise checking someone else's balance repeatedly minted the
    // achievement reward into *their* wallet.
    await UserManager.grantAchievement(interaction.user.id, 'first_balance').catch(() => {});
  },
});
