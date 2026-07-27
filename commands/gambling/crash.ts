import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ThumbnailBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import config from '../../config/config';
import { EMOJI as E } from '../../utils/Constants';

function generateCrash(): number {
  const e = config.gambling.crash.houseEdge;
  const r = Math.random();
  if (r < e) return 1.0;
  return Math.max(1.0, Math.floor((1 / (1 - r)) * 100) / 100);
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('crash').setDescription('Bet on a multiplier crash. Cash out before it crashes!')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true))
    .addNumberOption((o) => o.setName('cashout').setDescription('Auto cash-out multiplier (e.g. 2.0)').setMinValue(1.01).setMaxValue(100)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const bet = fmt.parseAmount(interaction.options.get('bet')!.value as string, wallet);
    const autoCashout = interaction.options.get('cashout')?.value as number | null ?? null;
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    const crashPoint = generateCrash();
    let currentMult = 1.0, cashedOut = false, cashoutMult: number | null = null;
    await UserManager.addWallet(interaction.user.id, -bet);

    const buildC = (mult: number, status: string) => new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent([`# Crash`, status].join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `**Multiplier:** ${mult.toFixed(2)}x`, `${E.COINS} **Bet:** ${fmt.coins(bet)}`,
        autoCashout ? `**Auto Cash-out:** ${autoCashout}x` : '',
      ].filter(Boolean).join('\n')));

    const cashoutBtn = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`crash_cashout:${interaction.user.id}`).setLabel('Cash Out!').setStyle(ButtonStyle.Success),
    );
    const msg = await interaction.editReply({ components: [buildC(currentMult, 'Rocket is climbing… Cash out before it crashes!').addActionRowComponents(cashoutBtn)] });
    const collector = (msg as { createMessageComponentCollector: (o: { filter: (i: { user: { id: string }; customId: string }) => boolean; time: number; max: number }) => { on: (e: string, cb: (...a: unknown[]) => void) => void; stop: (r?: string) => void } }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && i.customId.startsWith('crash_'), time: 20_000, max: 1,
    });

    const interval = setInterval(() => {
      currentMult = Math.round((currentMult + 0.1 + Math.random() * 0.3) * 100) / 100;
      if (autoCashout && currentMult >= autoCashout && !cashedOut) { cashedOut = true; cashoutMult = Math.min(currentMult, autoCashout); collector.stop('cashout'); return; }
      if (currentMult >= crashPoint && !cashedOut) { cashedOut = true; collector.stop('crashed'); }
    }, 1500);

    collector.on('collect', async (i: { deferUpdate: () => Promise<void> }) => {
      if (!cashedOut) { cashedOut = true; cashoutMult = currentMult; }
      await i.deferUpdate().catch(() => {});
    });
    collector.on('end', async (_: unknown, reason: string) => {
      clearInterval(interval);
      const won = cashedOut && cashoutMult !== null && cashoutMult >= 1.0;
      const payout = won ? Math.floor(bet * cashoutMult!) : 0;
      if (payout > 0) await UserManager.addWallet(interaction.user.id, payout);
      await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
      if (won) await UserManager.incrementStat(interaction.user.id, 'gamesWon');
      const eco = await UserManager.getEconomy(interaction.user.id);
      const crashed = reason === 'crashed' || !cashedOut;
      const status = crashed ? `# Crashed at ${crashPoint.toFixed(2)}x! You lost ${fmt.coins(bet)}.` : `# Cashed out at ${cashoutMult?.toFixed(2)}x! Won ${fmt.coins(payout - bet)}!`;
      const c = buildC(crashed ? crashPoint : cashoutMult ?? 1, status);
      c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`));
      await interaction.editReply({ components: [c] }).catch(() => {});
    });
  },
});
