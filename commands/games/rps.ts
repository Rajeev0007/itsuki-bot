/**
 * @file rps.ts
 * @description Rock-Paper-Scissors, played with buttons. Against another
 * user, choices stay hidden (each click is acknowledged ephemerally) until
 * both have picked; against the bot, it resolves instantly.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, type ChatInputCommandInteraction, type ButtonInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB      from '../../builders/ComponentBuilder';

type Choice = 'rock' | 'paper' | 'scissors';
const CHOICE_EMOJI: Record<Choice, string> = { rock: '🪨', paper: '📄', scissors: '✂️' };
const CHOICES: Choice[] = ['rock', 'paper', 'scissors'];

/** Returns 'p1' | 'p2' | 'draw' from p1's perspective. */
function resolve(p1: Choice, p2: Choice): 'p1' | 'p2' | 'draw' {
  if (p1 === p2) return 'draw';
  const beats: Record<Choice, Choice> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
  return beats[p1] === p2 ? 'p1' : 'p2';
}

function buildChoiceRow(gameId: string, disabled = false) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...CHOICES.map((c) =>
      new ButtonBuilder()
        .setCustomId(`rps_choice:${gameId}:${c}`)
        .setLabel(`${CHOICE_EMOJI[c]} ${c.charAt(0).toUpperCase() + c.slice(1)}`)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  );
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('rps')
    .setDescription('Play Rock-Paper-Scissors.')
    .addUserOption((o) => o.setName('opponent').setDescription('Challenge someone (omit to play against the bot).')),
  category: 'games',
  cooldown: 3000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const requestedOpponent = interaction.options.getUser('opponent');

    if (requestedOpponent && requestedOpponent.id === interaction.user.id) {
      return interaction.editReply(CB.errorResponse('Invalid Opponent', "You can't play against yourself.") as never);
    }

    // In a DM the challenged user has no access to this message, so their half
    // of the game could never be played — fall back to the bot opponent and say
    // so, rather than hanging until the collector expires.
    const inDM = !interaction.guild;
    const opponentUnreachable = Boolean(requestedOpponent) && inDM;
    const opponentUser = opponentUnreachable ? null : requestedOpponent;
    const vsBot = !opponentUser || opponentUser.bot;

    const gameId = `${interaction.user.id}${Date.now()}`;
    const p1Id = interaction.user.id;
    const p2Id = vsBot ? null : opponentUser!.id;
    const p1Name = interaction.user.username;
    const p2Name = vsBot ? 'the bot' : opponentUser!.username;

    const choices: Record<string, Choice> = {};

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `# 🪨📄✂️ Rock Paper Scissors`,
        vsBot ? `**${p1Name}** vs the bot` : `**${p1Name}** vs **${p2Name}**`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        opponentUnreachable
          ? `-# ${requestedOpponent!.username} can't be challenged in a DM, so you're playing the bot.`
          : '',
        vsBot ? 'Make your move.' : 'Both players: pick your move (kept secret until both have chosen).',
      ].filter(Boolean).join('\n')))
      .addActionRowComponents(buildChoiceRow(gameId));

    const msg = await interaction.editReply({ components: [container] });

    if (vsBot) {
      const collector = (msg as unknown as {
        createMessageComponentCollector: (o: { filter: (i: ButtonInteraction) => boolean; time: number; max: number }) =>
          { on: (e: string, cb: (...a: never[]) => void) => void };
      }).createMessageComponentCollector({
        filter: (i) => i.customId.startsWith(`rps_choice:${gameId}:`) && i.user.id === p1Id,
        time: 60_000, max: 1,
      });

      collector.on('collect', async (i: ButtonInteraction) => {
        const playerChoice = i.customId.split(':')[2] as Choice;
        const botChoice = CHOICES[Math.floor(Math.random() * CHOICES.length)];
        const result = resolve(playerChoice, botChoice);
        const status = result === 'draw'
          ? "**It's a draw!**"
          : result === 'p1' ? `**${p1Name} wins!**` : '**The bot wins!**';

        // rps previously recorded nothing at all, so it never contributed to
        // stats, the leaderboard or achievements.
        await UserManager.incrementStat(p1Id, 'gamesPlayed');
        if (result === 'p1') await UserManager.incrementStat(p1Id, 'gamesWon');

        await i.update({
          components: [
            new ContainerBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🪨📄✂️ Rock Paper Scissors`))
              .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
              .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                `**${p1Name}:** ${CHOICE_EMOJI[playerChoice]} ${playerChoice}`,
                `**Bot:** ${CHOICE_EMOJI[botChoice]} ${botChoice}`,
                '',
                status,
              ].join('\n')))
              .addActionRowComponents(buildChoiceRow(gameId, true)),
          ],
        });
      });
      return;
    }

    // ── vs another user ─────────────────────────────────────────────────────
    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: { filter: (i: ButtonInteraction) => boolean; time: number }) =>
        { on: (e: string, cb: (...a: never[]) => void) => void };
    }).createMessageComponentCollector({
      filter: (i) => i.customId.startsWith(`rps_choice:${gameId}:`) && (i.user.id === p1Id || i.user.id === p2Id),
      time: 2 * 60_000,
    });

    collector.on('collect', async (i: ButtonInteraction) => {
      if (choices[i.user.id]) {
        await i.reply({ content: 'You already locked in your choice.', flags: MessageFlags.Ephemeral });
        return;
      }
      const choice = i.customId.split(':')[2] as Choice;
      choices[i.user.id] = choice;
      await i.reply({ content: `Locked in **${choice}**. Waiting for the other player…`, flags: MessageFlags.Ephemeral });

      if (choices[p1Id] && p2Id && choices[p2Id]) {
        (collector as unknown as { stop: () => void }).stop();
        const result = resolve(choices[p1Id], choices[p2Id]);
        const status = result === 'draw'
          ? "**It's a draw!**"
          : result === 'p1' ? `**${p1Name} wins!**` : `**${p2Name} wins!**`;

        await UserManager.incrementStat(p1Id, 'gamesPlayed');
        await UserManager.incrementStat(p2Id, 'gamesPlayed');
        if (result === 'p1')      await UserManager.incrementStat(p1Id, 'gamesWon');
        else if (result === 'p2') await UserManager.incrementStat(p2Id, 'gamesWon');

        await interaction.editReply({
          components: [
            new ContainerBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# 🪨📄✂️ Rock Paper Scissors`))
              .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
              .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                `**${p1Name}:** ${CHOICE_EMOJI[choices[p1Id]]} ${choices[p1Id]}`,
                `**${p2Name}:** ${CHOICE_EMOJI[choices[p2Id]]} ${choices[p2Id]}`,
                '',
                status,
              ].join('\n')))
              .addActionRowComponents(buildChoiceRow(gameId, true)),
          ],
        });
      }
    });

    (collector as unknown as { on: (e: 'end', cb: (_: unknown, reason: string) => void) => void }).on('end', (_c, reason) => {
      if (reason === 'time' && !(choices[p1Id] && p2Id && choices[p2Id])) {
        interaction.editReply({
          ...CB.errorResponse('Timed Out', 'Not everyone locked in a choice in time.'),
        }).catch(() => {});
      }
    });
  },
});
