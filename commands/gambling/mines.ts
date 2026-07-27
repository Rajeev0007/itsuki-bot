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

const GRID = 5, TOTAL = GRID * GRID;

function calcMult(revealed: number, mines: number): number {
  let m = 1;
  for (let i = 0; i < revealed; i++) m *= (TOTAL - mines - i) / (TOTAL - i);
  return Math.max(1, parseFloat((0.97 / m).toFixed(2)));
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('mines').setDescription('Click tiles and avoid the mines! Cash out anytime.')
    .addStringOption((o) => o.setName('bet').setDescription('Amount to bet').setRequired(true))
    .addIntegerOption((o) => o.setName('mines').setDescription('Number of mines (1-24)').setMinValue(1).setMaxValue(24).setRequired(true)),
  category: 'gambling',
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const bet = fmt.parseAmount(interaction.options.get('bet')!.value as string, wallet);
    const mines = interaction.options.get('mines')!.value as number;
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet) return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);

    await UserManager.addWallet(interaction.user.id, -bet);
    const pos = Array.from({ length: TOTAL }, (_, i) => i);
    const mineSet = new Set(pos.sort(() => Math.random() - 0.5).slice(0, mines));
    const revealed = new Set<number>();
    let alive = true, cashoutMult = 1;

    const buildRows = (revealAll = false) => {
      const rows = [];
      for (let row = 0; row < GRID; row++) {
        const r = new ActionRowBuilder<ButtonBuilder>();
        for (let col = 0; col < GRID; col++) {
          const idx = row * GRID + col;
          const isRev = revealed.has(idx), isMine = mineSet.has(idx);
          let style = ButtonStyle.Secondary, label = '\u200b', disabled = isRev || !alive;
          if (isRev) { label = isMine ? 'X' : '$'; style = isMine ? ButtonStyle.Danger : ButtonStyle.Success; disabled = true; }
          else if (revealAll) { label = isMine ? 'X' : '$'; style = isMine ? ButtonStyle.Danger : ButtonStyle.Secondary; disabled = true; }
          r.addComponents(new ButtonBuilder().setCustomId(`mines_tile:${interaction.user.id}:${idx}`).setLabel(label).setStyle(style).setDisabled(disabled));
        }
        rows.push(r);
      }
      return rows;
    };

    const buildInfo = () => new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        new TextDisplayBuilder().setContent(alive ? `# Mines — ${mines} bombs hidden` : '# BOOM! You hit a mine!')
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.COINS} **Bet:** ${fmt.coins(bet)}`, `**Gems found:** ${revealed.size}`,
        `**Multiplier:** ${cashoutMult.toFixed(2)}x`, `**Cashout:** ${fmt.coins(Math.floor(bet * cashoutMult))}`,
      ].join('\n')));

    const cashoutRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mines_cashout:${interaction.user.id}`).setLabel(`Cash Out (${cashoutMult.toFixed(2)}x)`).setStyle(ButtonStyle.Success),
    );

    const assembleGame = (info: ContainerBuilder, rows: ReturnType<typeof buildRows>, cashout?: ReturnType<typeof cashoutRow>) => {
      for (const r of rows) info.addActionRowComponents(r);
      if (cashout) info.addActionRowComponents(cashout);
      return info;
    };

    const msg = await interaction.editReply({ components: [assembleGame(buildInfo(), buildRows(), cashoutRow())] });
    const collector = (msg as { createMessageComponentCollector: (o: { filter: (i: { user: { id: string }; customId: string }) => boolean; time: number }) => { on: (e: string, cb: (i: { customId: string; update: (o: unknown) => Promise<void> }) => void) => void } }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id && (i.customId.startsWith('mines_tile:') || i.customId.startsWith('mines_cashout:')), time: 120_000,
    });

    collector.on('collect', async (i) => {
      const [action,, idxStr] = i.customId.split(':');
      if (action === 'mines_cashout') {
        alive = false;
        const payout = Math.floor(bet * cashoutMult);
        await UserManager.addWallet(interaction.user.id, payout);
        await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
        await UserManager.incrementStat(interaction.user.id, 'gamesWon');
        const eco = await UserManager.getEconomy(interaction.user.id);
        const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([`# Cashed Out!`, `You cashed out **${cashoutMult.toFixed(2)}x** and won **${fmt.coins(payout - bet)}**!`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`].join('\n')));
        await i.update({ components: [assembleGame(c, buildRows(true))] });
        return;
      }
      const idx = parseInt(idxStr);
      if (mineSet.has(idx)) {
        alive = false; revealed.add(idx);
        await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
        const eco = await UserManager.getEconomy(interaction.user.id);
        const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([`# BOOM! You hit a mine!`, `Lost **${fmt.coins(bet)}**!`, `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`].join('\n')));
        await i.update({ components: [assembleGame(c, buildRows(true))] });
        return;
      }
      revealed.add(idx);
      cashoutMult = calcMult(revealed.size, mines);
      await i.update({ components: [assembleGame(buildInfo(), buildRows(), cashoutRow())] });
    });
  },
});
