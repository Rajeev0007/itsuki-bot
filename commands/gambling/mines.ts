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
const COLLECTOR_MS = 120_000;

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
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const { wallet } = await UserManager.getBalance(interaction.user.id);
    const rawBet = interaction.options.getString('bet');
    if (!rawBet)
      return interaction.editReply({ ...CB.errorResponse('Missing Bet', 'Tell me how much to bet, e.g. `500`, `10k`, `half` or `all`.') } as never);

    const bet = fmt.parseAmount(rawBet, wallet);
    const mines = interaction.options.getInteger('mines');
    if (!bet || bet < config.gambling.minBet || bet > config.gambling.maxBet)
      return interaction.editReply({ ...CB.errorResponse('Invalid Bet', `Bet between ${fmt.coins(config.gambling.minBet)} and ${fmt.coins(config.gambling.maxBet)}.`) } as never);
    if (bet > wallet)
      return interaction.editReply({ ...CB.errorResponse('Broke', `You only have ${fmt.coins(wallet)}.`) } as never);
    if (!mines || mines < 1 || mines > TOTAL - 1)
      return interaction.editReply({ ...CB.errorResponse('Invalid Mines', `Pick between 1 and ${TOTAL - 1} mines.`) } as never);

    await UserManager.addWallet(interaction.user.id, -bet);

    const pos = Array.from({ length: TOTAL }, (_, i) => i);
    const mineSet = new Set(pos.sort(() => Math.random() - 0.5).slice(0, mines));
    const revealed = new Set<number>();
    /** Total safe tiles — clearing them all is a win. */
    const gemCount = TOTAL - mines;
    let alive = true, cashoutMult = 1;
    let settled = false;

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
        new TextDisplayBuilder().setContent(`# Mines — ${mines} bomb${mines !== 1 ? 's' : ''} hidden`),
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(interaction.user.displayAvatarURL({ size: 256 }))))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${E.COINS} **Bet:** ${fmt.coins(bet)}`,
        `**Gems found:** ${revealed.size} / ${gemCount}`,
        `**Multiplier:** ${cashoutMult.toFixed(2)}x`,
        `**Cashout:** ${fmt.coins(Math.floor(bet * cashoutMult))}`,
      ].join('\n')));

    const cashoutRow = () => new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`mines_cashout:${interaction.user.id}`).setLabel(`Cash Out (${cashoutMult.toFixed(2)}x)`).setStyle(ButtonStyle.Success),
    );

    const assembleGame = (info: ContainerBuilder, rows: ReturnType<typeof buildRows>, cashout?: ReturnType<typeof cashoutRow>) => {
      for (const r of rows) info.addActionRowComponents(r);
      if (cashout) info.addActionRowComponents(cashout);
      return info;
    };

    /** Pays out the current multiplier and renders the final board. */
    const settleCashout = async (
      heading: string,
      render: (payload: { components: ContainerBuilder[] }) => Promise<unknown>,
    ) => {
      if (settled) return;
      settled = true;
      alive = false;

      const payout = Math.floor(bet * cashoutMult);
      await UserManager.addWallet(interaction.user.id, payout);
      await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
      // Cashing out at 1.00x with no gems found just returns the stake — that
      // is not a win, and counting it as one inflated the win stats.
      if (payout > bet) await UserManager.incrementStat(interaction.user.id, 'gamesWon');
      await UserManager.recordTransaction(
        interaction.user.id, payout > bet ? 'gambling_win' : 'gambling_loss', payout - bet, 'Mines',
      );

      const eco = await UserManager.getEconomy(interaction.user.id);
      const profit = payout - bet;
      const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
        heading,
        profit > 0
          ? `You cashed out **${cashoutMult.toFixed(2)}x** and won **${fmt.coins(profit)}**!`
          : `Your stake of **${fmt.coins(bet)}** was returned.`,
        `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
      ].join('\n')));
      await render({ components: [assembleGame(c, buildRows(true))] });
    };

    const msg = await interaction.editReply({ components: [assembleGame(buildInfo(), buildRows(), cashoutRow())] });

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: { filter: (i: { user: { id: string }; customId: string }) => boolean; time: number }) =>
        { on: (e: string, cb: (...a: never[]) => void) => void; stop: (r?: string) => void };
    }).createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id
        && (i.customId.startsWith('mines_tile:') || i.customId.startsWith('mines_cashout:')),
      time: COLLECTOR_MS,
    });

    collector.on('collect', async (i: { customId: string; update: (o: unknown) => Promise<void> }) => {
      if (settled) return;
      const [action, , idxStr] = i.customId.split(':');

      if (action === 'mines_cashout') {
        collector.stop('cashout');
        await settleCashout('# Cashed Out!', (p) => i.update(p));
        return;
      }

      const idx = parseInt(idxStr, 10);
      if (!Number.isInteger(idx) || revealed.has(idx)) return;

      if (mineSet.has(idx)) {
        settled = true;
        alive = false;
        revealed.add(idx);
        collector.stop('boom');
        await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
        await UserManager.recordTransaction(interaction.user.id, 'gambling_loss', -bet, 'Mines');
        const eco = await UserManager.getEconomy(interaction.user.id);
        const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# BOOM! You hit a mine!`,
          `Lost **${fmt.coins(bet)}**!`,
          `${E.WALLET} **Wallet:** ${fmt.coins(eco.wallet)}`,
        ].join('\n')));
        await i.update({ components: [assembleGame(c, buildRows(true))] });
        return;
      }

      revealed.add(idx);
      cashoutMult = calcMult(revealed.size, mines);

      // Clearing every safe tile is a win. Previously the board just ran out of
      // gems and the only remaining tiles were mines, so a perfect run could
      // only ever end in "BOOM".
      if (revealed.size >= gemCount) {
        collector.stop('cleared');
        await settleCashout('# Perfect Clear!', (p) => i.update(p));
        return;
      }

      await i.update({ components: [assembleGame(buildInfo(), buildRows(), cashoutRow())] });
    });

    collector.on('end', async (_c: unknown, reason: string) => {
      // Never abandon a live game: an expired round auto-cashes-out at the
      // multiplier reached, instead of silently pocketing the player's bet.
      if (reason === 'time' && !settled) {
        await settleCashout(
          '# Time’s Up — Auto Cashed Out',
          (p) => interaction.editReply(p as never).then(() => undefined),
        ).catch(() => {});
      }
    });
  },
});
