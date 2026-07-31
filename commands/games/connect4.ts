import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction, type ButtonInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';

const COLS = 7, ROWS = 6;
const EMPTY = 0, P1 = 1, P2 = 2;
const DISCS = ['⚫', '🔴', '🟡'];
const COL_LABELS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const REWARD = 500;

type Cell = 0 | 1 | 2;
/** Board is row-major, row 0 is the TOP. */
type Board = Cell[][];

function newBoard(): Board {
  return Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => EMPTY as Cell));
}

/** Lowest empty row in a column, or -1 when full. */
function dropRow(board: Board, col: number): number {
  for (let r = ROWS - 1; r >= 0; r--) {
    if (board[r][col] === EMPTY) return r;
  }
  return -1;
}

/**
 * Checks for four in a row through the piece just placed.
 *
 * Only the four directions need testing (horizontal, vertical, and both
 * diagonals); each is walked in BOTH directions from the placed piece, which is
 * what makes a win detected from the middle of a line rather than only its end.
 */
function findWin(board: Board, row: number, col: number): Array<[number, number]> | null {
  const player = board[row][col];
  if (player === EMPTY) return null;

  const directions: Array<[number, number]> = [
    [0, 1],  // horizontal
    [1, 0],  // vertical
    [1, 1],  // diagonal ↘
    [1, -1], // diagonal ↙
  ];

  for (const [dr, dc] of directions) {
    const line: Array<[number, number]> = [[row, col]];

    for (const sign of [1, -1]) {
      let r = row + dr * sign;
      let c = col + dc * sign;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) {
        line.push([r, c]);
        r += dr * sign;
        c += dc * sign;
      }
    }

    if (line.length >= 4) return line;
  }
  return null;
}

function isFull(board: Board): boolean {
  return board[0].every((cell) => cell !== EMPTY);
}

function renderBoard(board: Board, winning: Array<[number, number]> | null): string {
  const winSet = new Set((winning ?? []).map(([r, c]) => `${r},${c}`));
  const rows = board.map((row, r) =>
    row.map((cell, c) => (winSet.has(`${r},${c}`) ? '🟢' : DISCS[cell])).join(''),
  );
  return [...rows, COL_LABELS.join('')].join('\n');
}

function buildRows(gameId: string, board: Board, disabled: boolean): ActionRowBuilder<ButtonBuilder>[] {
  const make = (from: number, to: number) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...COL_LABELS.slice(from, to).map((label, i) => {
        const col = from + i;
        return new ButtonBuilder()
          .setCustomId(`c4:${gameId}:${col}`)
          .setEmoji(label)
          .setStyle(ButtonStyle.Secondary)
          // A full column can't accept a disc, so disable it rather than
          // letting the click fail silently.
          .setDisabled(disabled || dropRow(board, col) === -1);
      }),
    );
  // 7 columns exceed the 5-button row limit, so split 4 + 3.
  return [make(0, 4), make(4, 7)];
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('connect4').setDescription('Connect Four — line up four discs against another player.')
    .addUserOption((o) => o.setName('opponent').setDescription('Who to play against').setRequired(true)),
  category: 'games',
  guildOnly: true,
  aliases: ['c4'],
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const opponent = interaction.options.getUser('opponent');
    if (!opponent) return interaction.editReply({ ...CB.errorResponse('Missing Opponent', 'Pick someone to play.') } as never);
    if (opponent.id === interaction.user.id) {
      return interaction.editReply({ ...CB.errorResponse('Invalid Opponent', 'You cannot play against yourself.') } as never);
    }
    if (opponent.bot) {
      return interaction.editReply({ ...CB.errorResponse('Invalid Opponent', 'Pick a human opponent.') } as never);
    }

    const board = newBoard();
    const players = [
      { id: interaction.user.id, name: interaction.user.username, disc: DISCS[P1] },
      { id: opponent.id, name: opponent.username, disc: DISCS[P2] },
    ];
    let turnIdx = 0;
    let finished = false;
    const gameId = `${interaction.user.id}${Date.now().toString(36)}`;

    const render = (status: string, winning: Array<[number, number]> | null, disabled: boolean) => {
      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# 🔴🟡 Connect Four',
          `${players[0].disc} **${players[0].name}**  vs  ${players[1].disc} **${players[1].name}**`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(renderBoard(board, winning)))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(status));
      for (const row of buildRows(gameId, board, disabled)) c.addActionRowComponents(row);
      return c;
    };

    const msg = await interaction.editReply({
      components: [render(`${players[0].disc} **${players[0].name}**'s turn`, null, false)],
    } as never);

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: {
        filter: (i: ButtonInteraction) => boolean; time: number; idle: number;
      }) => { on: (e: string, cb: (...a: never[]) => void) => void; stop: (r?: string) => void };
    }).createMessageComponentCollector({
      filter: (i) => i.customId.startsWith(`c4:${gameId}:`)
        && (i.user.id === players[0].id || i.user.id === players[1].id),
      time: 15 * 60_000,
      idle: 3 * 60_000,
    });

    collector.on('collect', async (i: ButtonInteraction) => {
      if (finished) return;

      // Turn order is enforced here, not by the filter — the filter has to admit
      // both players so the wrong one can be told it isn't their turn.
      if (i.user.id !== players[turnIdx].id) {
        await i.reply({ content: "It's not your turn.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      const col = Number(i.customId.split(':')[2]);
      if (!Number.isInteger(col) || col < 0 || col >= COLS) return;

      const row = dropRow(board, col);
      if (row === -1) {
        await i.reply({ content: 'That column is full.', flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      const disc = (turnIdx === 0 ? P1 : P2) as Cell;
      board[row][col] = disc;

      const win = findWin(board, row, col);
      if (win) {
        finished = true;
        collector.stop('win');
        const winner = players[turnIdx];
        const loser = players[1 - turnIdx];

        await UserManager.incrementStat(winner.id, 'gamesPlayed');
        await UserManager.incrementStat(loser.id, 'gamesPlayed');
        await UserManager.incrementStat(winner.id, 'gamesWon');
        await UserManager.addWallet(winner.id, REWARD);
        await UserManager.recordTransaction(winner.id, 'connect4', REWARD, 'Connect Four victory');

        await i.update({
          components: [render(
            `## 🏆 ${winner.disc} ${winner.name} wins!\nEarned **${fmt.coins(REWARD)}**.`,
            win, true,
          )],
        } as never);
        return;
      }

      if (isFull(board)) {
        finished = true;
        collector.stop('draw');
        await UserManager.incrementStat(players[0].id, 'gamesPlayed');
        await UserManager.incrementStat(players[1].id, 'gamesPlayed');
        await i.update({
          components: [render('## Draw — the board is full!', null, true)],
        } as never);
        return;
      }

      turnIdx = 1 - turnIdx;
      await i.update({
        components: [render(`${players[turnIdx].disc} **${players[turnIdx].name}**'s turn`, null, false)],
      } as never);
    });

    collector.on('end', async (_c: unknown, reason: string) => {
      if (finished) return;
      await interaction.editReply({
        components: [render(
          reason === 'idle'
            ? `-# Timed out — ${players[turnIdx].name} took too long.`
            : '-# Game expired.',
          null, true,
        )],
      } as never).catch(() => {});
    });
  },
});
