/**
 * @file trivia.ts
 * @description Multiple-choice trivia answered via a select menu.
 * Correct answers award a small coin bonus.
 */

import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder,
  StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction, type StringSelectMenuInteraction,
} from 'discord.js';
import { Command }    from '../../structures/Command';
import TriviaService  from '../../services/TriviaService';
import UserManager    from '../../managers/UserManager';
import fmt            from '../../utils/Formatter';
import * as CB         from '../../builders/ComponentBuilder';

const REWARD: Record<string, number> = { easy: 50, medium: 100, hard: 200 };
const TIME_LIMIT = 20_000;

function buildMenu(gameId: string, answers: string[], disabled = false) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`trivia_answer:${gameId}`)
    .setPlaceholder('Choose your answer…')
    .setDisabled(disabled)
    .addOptions(
      answers.map((a, i) =>
        new StringSelectMenuOptionBuilder().setLabel(a.slice(0, 100)).setValue(String(i)),
      ),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('trivia')
    .setDescription('Answer a trivia question for coins.')
    .addStringOption((o) =>
      o.setName('difficulty').setDescription('Question difficulty')
        .addChoices({ name: 'Easy', value: 'easy' }, { name: 'Medium', value: 'medium' }, { name: 'Hard', value: 'hard' }),
    ),
  category: 'games',
  cooldown: 5000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const difficulty = (interaction.options.getString('difficulty') as 'easy' | 'medium' | 'hard' | null) ?? undefined;
    const q = await TriviaService.getQuestion(difficulty);

    if (!q) {
      return interaction.editReply(CB.errorResponse('Failed', 'Could not fetch a trivia question. Try again.') as never);
    }

    const gameId = `${interaction.user.id}${Date.now()}`;
    const reward = REWARD[q.difficulty] ?? 50;
    /** True once the player has picked an answer, so the 'end' handler stands down. */
    let answered = false;

    const container = new ContainerBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `# ❓ Trivia — ${q.category}`,
        `*${q.difficulty} • worth ${reward} coins*`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(q.question))
      .addActionRowComponents(buildMenu(gameId, q.answers));

    const msg = await interaction.editReply({ components: [container] });

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: { filter: (i: StringSelectMenuInteraction) => boolean; time: number; max: number }) =>
        { on: (e: string, cb: (...a: never[]) => void) => void };
    }).createMessageComponentCollector({
      filter: (i) => i.customId === `trivia_answer:${gameId}` && i.user.id === interaction.user.id,
      time: TIME_LIMIT, max: 1,
    });

    collector.on('collect', async (i: StringSelectMenuInteraction) => {
      answered = true;
      const chosenIdx = Number(i.values[0]);
      const chosen = q.answers[chosenIdx];
      const correct = chosen === q.correctAnswer;

      const status = correct
        ? `**Correct!** You earned ${fmt.coins(reward)}.`
        : `**Wrong.** The correct answer was **${q.correctAnswer}**.`;

      // Answer the interaction BEFORE the four store writes below. They shared
      // the 3-second component acknowledgement budget, so a slow store left the
      // question frozen with its menu open even though the reward had been paid.
      await i.update({
        components: [
          new ContainerBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ❓ Trivia — ${q.category}`))
            .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent([q.question, '', status].join('\n')))
            .addActionRowComponents(buildMenu(gameId, q.answers, true)),
        ],
      }).catch(() => {});

      // Trivia recorded nothing at all — no games played, no games won, no
      // transaction — so it never counted toward stats or achievements the way
      // every other game does.
      await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
      if (correct) {
        await UserManager.incrementStat(interaction.user.id, 'gamesWon');
        await UserManager.creditWallet(interaction.user.id, reward);
        await UserManager.recordTransaction(interaction.user.id, 'trivia', reward, `Trivia — ${q.category}`);
        await UserManager.checkAchievements(interaction.user.id);
      }
    });

    (collector as unknown as { on: (e: 'end', cb: (_: unknown, reason: string) => void) => void }).on('end', (_c, _reason) => {
      // Every end reason, not just 'time' — 'idle', 'messageDelete',
      // 'channelDelete' and 'guildDelete' all left the menu live. Gated on
      // `answered` instead, which is the condition that actually matters.
      if (!answered) {
        // An unanswered question still counts as a game played.
        void UserManager.incrementStat(interaction.user.id, 'gamesPlayed').catch(() => {});
        interaction.editReply({
          components: [
            new ContainerBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent(`# ❓ Trivia — ${q.category}`))
              .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
              .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                q.question, '', `**Time's up.** The correct answer was **${q.correctAnswer}**.`,
              ].join('\n')))
              .addActionRowComponents(buildMenu(gameId, q.answers, true)),
          ],
        }).catch(() => {});
      }
    });
  },
});
