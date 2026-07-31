/**
 * @file tictactoe.ts
 * @description Two-player Tic-Tac-Toe played entirely with buttons.
 * Games are the one deliberate exception to the bot's otherwise emoji-free
 * style — X/O/blank use distinct symbols so the board reads at a glance.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, type ChatInputCommandInteraction, type ButtonInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import * as CB      from '../../builders/ComponentBuilder';

const X = '❌';
const O = '⭕';
const BLANK = '\u200b';

const WIN_LINES = [
  [0,1,2],[3,4,5],[6,7,8], // rows
  [0,3,6],[1,4,7],[2,5,8], // columns
  [0,4,8],[2,4,6],         // diagonals
];

function checkWinner(board: string[]): string | null {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  }
  return null;
}

function buildBoard(board: string[], p1: { id: string; username: string }, p2: { id: string; username: string }, turn: string, status: string, gameId: string, ended = false) {
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];
  for (let r = 0; r < 3; r++) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    for (let c = 0; c < 3; c++) {
      const idx = r * 3 + c;
      const cell = board[idx];
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`ttt_cell:${gameId}:${idx}`)
          .setLabel(cell || BLANK)
          .setStyle(cell === X ? ButtonStyle.Danger : cell === O ? ButtonStyle.Primary : ButtonStyle.Secondary)
          .setDisabled(!!cell || ended),
      );
    }
    rows.push(row);
  }

  const container = new ContainerBuilder()
    .addTextDisplayComponents(new TextDisplayBuilder().setContent([
      `# ${X} Tic-Tac-Toe ${O}`,
      `**${p1.username}** (${X}) vs **${p2.username}** (${O})`,
    ].join('\n')))
    .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent(status));

  for (const row of rows) container.addActionRowComponents(row);
  return container;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('tictactoe')
    .setDescription('Challenge someone to Tic-Tac-Toe.')
    .addUserOption((o) => o.setName('opponent').setDescription('Who do you want to play against?').setRequired(true)),
  category: 'games',
  cooldown: 5000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const opponent = interaction.options.getUser('opponent', true);
    if (opponent.id === interaction.user.id) {
      return interaction.editReply(CB.errorResponse('Invalid Opponent', "You can't play against yourself.") as never);
    }
    if (opponent.bot) {
      return interaction.editReply(CB.errorResponse('Invalid Opponent', 'You can\'t challenge a bot.') as never);
    }

    const p1 = { id: interaction.user.id, username: interaction.user.username };
    const p2 = { id: opponent.id, username: opponent.username };
    const board: string[] = new Array(9).fill('');
    let turn = p1.id;
    const gameId = `${p1.id}${Date.now()}`;

    const msg = await interaction.editReply({
      components: [buildBoard(board, p1, p2, turn, `**${p1.username}'s turn** (${X})`, gameId)],
    });

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: { filter: (i: ButtonInteraction) => boolean; time: number }) =>
        { on: (e: string, cb: (...a: never[]) => void) => void };
    }).createMessageComponentCollector({
      filter: (i) => i.customId.startsWith(`ttt_cell:${gameId}:`) && (i.user.id === p1.id || i.user.id === p2.id),
      time: 5 * 60_000,
    });

    collector.on('collect', async (i: ButtonInteraction) => {
      if (i.user.id !== turn) {
        await i.reply({ content: "It's not your turn.", flags: MessageFlags.Ephemeral });
        return;
      }

      const idx = Number(i.customId.split(':')[2]);
      if (board[idx]) return; // shouldn't happen (button disabled), guard anyway

      const mark = turn === p1.id ? X : O;
      board[idx] = mark;

      const winner = checkWinner(board);
      const isDraw  = !winner && board.every((c) => c);

      if (winner || isDraw) {
        (collector as unknown as { stop: () => void }).stop();
        const status = winner
          ? `**${winner === X ? p1.username : p2.username}** wins! (${winner})`
          : "**It's a draw!**";
        await i.update({ components: [buildBoard(board, p1, p2, turn, status, gameId, true)] });
        return;
      }

      turn = turn === p1.id ? p2.id : p1.id;
      const nextMark = turn === p1.id ? X : O;
      const nextName = turn === p1.id ? p1.username : p2.username;
      await i.update({ components: [buildBoard(board, p1, p2, turn, `**${nextName}'s turn** (${nextMark})`, gameId)] });
    });

    (collector as unknown as { on: (e: 'end', cb: (_: unknown, reason: string) => void) => void }).on('end', (_c, reason) => {
      if (reason === 'time') {
        interaction.editReply({
          components: [buildBoard(board, p1, p2, turn, '**Game expired** — took too long to finish.', gameId, true)],
        }).catch(() => {});
      }
    });
  },
});
