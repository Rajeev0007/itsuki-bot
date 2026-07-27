import {
  MessageFlags, ContainerBuilder, SectionBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  type ButtonInteraction,
} from 'discord.js';
import UserManager from '../../managers/UserManager';
import EconomyManager from '../../managers/EconomyManager';
import fmt from '../../utils/Formatter';
import ProgressBar from '../../utils/ProgressBar';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

export const customId = 'balance_:*';

export async function execute(interaction: ButtonInteraction): Promise<void> {
  const parts = interaction.customId.split(':');
  const action = parts[0]; // e.g. balance_refresh, balance_deposit, balance_withdraw
  const targetUserId = parts[1];

  if (targetUserId !== interaction.user.id) {
    await interaction.reply({ content: ' This button is not for you.', ephemeral: true });
    return;
  }

  await interaction.deferUpdate();

  if (action === 'balance_deposit') {
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const amount = Math.min(wallet, config.economy.bankLimit - (await UserManager.getEconomy(interaction.user.id)).bank);
    if (amount <= 0) {
      await interaction.followUp({ content: ' Nothing to deposit (wallet empty or bank full).', ephemeral: true });
      return;
    }
    await EconomyManager.deposit(interaction.user.id, amount);
    const eco = await UserManager.getEconomy(interaction.user.id);
    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([
            `# ${E.DEPOSIT} Deposited All`,
            `Moved **${fmt.coins(amount)}** to your bank.`,
          ].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
        `${E.BANK} **Bank:** ${fmt.coins(eco.bank)}`,
      ].join('\n')));
    await interaction.editReply({ components: [container] });
    return;
  }

  if (action === 'balance_withdraw') {
    const eco = await UserManager.getEconomy(interaction.user.id);
    const amount = Math.min(eco.bank, config.economy.maxWallet - eco.wallet);
    if (amount <= 0) {
      await interaction.followUp({ content: ' Nothing to withdraw (bank empty or wallet full).', ephemeral: true });
      return;
    }
    await EconomyManager.withdraw(interaction.user.id, amount);
    const ecoAfter = await UserManager.getEconomy(interaction.user.id);
    const container = new ContainerBuilder()
      .addSectionComponents(
        new SectionBuilder().addTextDisplayComponents(
          new TextDisplayBuilder().setContent([
            `# ${E.WITHDRAW} Withdrew All`,
            `Moved **${fmt.coins(amount)}** to your wallet.`,
          ].join('\n'))
        ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
      )
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.WALLET} **Wallet:** ${fmt.coins(ecoAfter.wallet)}`,
        `${E.BANK} **Bank:** ${fmt.coins(ecoAfter.bank)}`,
      ].join('\n')));
    await interaction.editReply({ components: [container] });
    return;
  }

  // Default: balance_refresh
  const eco = await UserManager.getEconomy(interaction.user.id);
  const user = await UserManager.getUser(interaction.user.id, interaction.guild?.id);
  const xpNeeded = UserManager.xpNeeded(user.level + 1);
  const xpBar = ProgressBar.create(user.xp, xpNeeded, 12);

  const container = new ContainerBuilder()
    .addSectionComponents(
      new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([
          `# ${E.COINS} Balance — ${interaction.user.username}`,
          `*Refreshed just now*`,
        ].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 })))
    )
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
      `${E.BANK} **Bank:** ${fmt.coins(eco.bank)}`,
      `**Net Worth:** ${fmt.coins(eco.wallet + eco.bank)}`,
      '',
      `${E.LEVEL} **Level:** ${user.level} • ${E.XP} **XP:** ${fmt.number(user.xp)} / ${fmt.number(xpNeeded)}`,
      xpBar,
      `${E.PRESTIGE} **Prestige:** ${user.prestige ?? 0}`,
    ].join('\n')));

  await interaction.editReply({ components: [container] });
}
