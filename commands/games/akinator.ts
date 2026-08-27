import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ChatInputCommandInteraction, type ButtonInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import AkinatorService, {
  ANSWERS, AkinatorError, type AkiSession, type AkiTurn, type AnswerId,
} from '../../services/AkinatorService';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import ProgressBar from '../../utils/ProgressBar';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

/** Akinator normally solves in ~25 questions; cap so a game can't run forever. */
const MAX_QUESTIONS = 80;
/** Cap on "that's wrong, keep guessing" presses, so the loop cannot run forever. */
const MAX_REJECTIONS = 10;
const TURN_TIMEOUT_MS = 3 * 60_000;
const WIN_REWARD = 400;

function answerRows(gameId: string, disabled = false): ActionRowBuilder<ButtonBuilder>[] {
  const styles: Record<AnswerId, ButtonStyle> = {
    yes: ButtonStyle.Success,
    no: ButtonStyle.Danger,
    dont_know: ButtonStyle.Secondary,
    probably: ButtonStyle.Primary,
    probably_not: ButtonStyle.Primary,
  };

  // 5 answers + Stop = 6 buttons, so they need two rows (max 5 per row).
  const first = ANSWERS.slice(0, 3);
  const second = ANSWERS.slice(3);

  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...first.map((a) => new ButtonBuilder()
        .setCustomId(`aki:${gameId}:${a.id}`)
        .setLabel(a.label)
        .setStyle(styles[a.id])
        .setDisabled(disabled)),
    ),
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...second.map((a) => new ButtonBuilder()
        .setCustomId(`aki:${gameId}:${a.id}`)
        .setLabel(a.label)
        .setStyle(styles[a.id])
        .setDisabled(disabled)),
      new ButtonBuilder()
        .setCustomId(`aki:${gameId}:stop`)
        .setLabel('Give up')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled),
    ),
  ];
}

function guessRows(gameId: string, disabled = false): ActionRowBuilder<ButtonBuilder>[] {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`aki:${gameId}:correct`)
        .setLabel("That's right!").setStyle(ButtonStyle.Success).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`aki:${gameId}:wrong`)
        .setLabel('Keep guessing').setStyle(ButtonStyle.Danger).setDisabled(disabled),
      new ButtonBuilder().setCustomId(`aki:${gameId}:stop`)
        .setLabel('Give up').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
    ),
  ];
}

function renderTurn(turn: AkiTurn, username: string, questionNo: number): ContainerBuilder {
  const container = new ContainerBuilder();

  if (turn.kind === 'question') {
    const confidence = Math.round(turn.progression);
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
      '# 🔮 Akinator',
      `-# Question ${questionNo} · thinking of a character for **${username}**`,
    ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`## ${turn.question}`))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(
        `**Confidence** ${ProgressBar.create(confidence, 100, 14)} ${confidence}%`,
      ));
    return container;
  }

  container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
    '# 🔮 I think I know!',
    `## ${turn.name}`,
    turn.description ? `-# ${turn.description}` : '',
    `**Confidence:** ${Math.round(turn.progression)}%`,
  ].filter(Boolean).join('\n')));

  if (turn.photo) {
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(turn.photo)),
    );
  }
  container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
    .addTextDisplayComponents(new TextDisplayBuilder().setContent('Am I right?'));
  return container;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('akinator').setDescription('Think of a character and let Akinator guess it.')
    .addStringOption((o) => o.setName('language').setDescription('Question language')
      .addChoices(
        { name: 'English', value: 'en' }, { name: 'French', value: 'fr' },
        { name: 'German', value: 'de' }, { name: 'Spanish', value: 'es' },
        { name: 'Italian', value: 'it' }, { name: 'Portuguese', value: 'pt' },
        { name: 'Japanese', value: 'jp' }, { name: 'Russian', value: 'ru' },
      )),
  category: 'games',
  aliases: ['aki'],
  cooldown: 10_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const region = interaction.options.getString('language') ?? 'en';
    if (!AkinatorService.isValidRegion(region)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unsupported Language', `Choose one of: ${AkinatorService.regions().join(', ')}.`,
      ) } as never);
    }

    // ── Start ───────────────────────────────────────────────────────────────
    let session: AkiSession;
    let turn: AkiTurn;
    try {
      const started = await AkinatorService.start(region);
      session = started.session;
      turn = started.turn;
    } catch (err) {
      const aki = err as AkinatorError;
      logger.warn(`[Akinator] Start failed: ${aki.message}`);
      return interaction.editReply({ ...CB.errorResponse(
        'Akinator Unavailable',
        [
          aki.message,
          aki.retryable
            ? '-# This is usually temporary — try again in a moment.'
            : '-# Akinator provides no official API, so this can break when their site changes.',
        ].join('\n'),
      ) } as never);
    }

    const gameId = `${interaction.user.id}${Date.now().toString(36)}`;
    let questionNo = 1;
    let rejections = 0;
    let finished = false;

    /** Builds a turn with the controls that match it (answers vs guess). */
    const withControls = (current: AkiTurn, disabled = false): ContainerBuilder => {
      const c = renderTurn(current, interaction.user.username, questionNo);
      const rows = current.kind === 'question'
        ? answerRows(gameId, disabled)
        : guessRows(gameId, disabled);
      for (const row of rows) c.addActionRowComponents(row);
      return c;
    };

    const msg = await interaction.editReply({ components: [withControls(turn)] } as never);

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: {
        filter: (i: ButtonInteraction) => boolean; time: number; idle: number;
      }) => { on: (e: string, cb: (...a: never[]) => void) => void; stop: (r?: string) => void };
    }).createMessageComponentCollector({
      // Only the player drives their own game.
      filter: (i) => i.customId.startsWith(`aki:${gameId}:`) && i.user.id === interaction.user.id,
      // Must stay INSIDE the 15-minute interaction-token lifetime. At 20 minutes
      // the 'end' handler's editReply was guaranteed to fail on the time path, so
      // an expired game never visibly closed and kept its buttons enabled.
      time: 14 * 60_000,
      // Reset on each answer, so a long game doesn't die mid-way.
      idle: TURN_TIMEOUT_MS,
    });

    // editReply, not i.update: the click is acknowledged with deferUpdate at the
    // top of the collect handler (see below), which consumes the component
    // interaction's one allowed response. Also .catch'd — an expired token must
    // not become an unhandled rejection inside a collector listener.
    const push = async (_i: ButtonInteraction, current: AkiTurn) => {
      await interaction.editReply({ components: [withControls(current)] } as never).catch(() => {});
    };

    const endWith = async (_i: ButtonInteraction | null, container: ContainerBuilder) => {
      finished = true;
      collector.stop('done');
      await interaction.editReply({ components: [container] } as never).catch(() => {});
    };

    collector.on('collect', async (i: ButtonInteraction) => {
      if (finished) return;

      // Acknowledge IMMEDIATELY, before any slow work.
      //
      // Discord invalidates a component interaction token 3 seconds after it is
      // received, and the branches below call AkinatorService (an HTTP client
      // scraping akinator.com with a 12-second timeout) BEFORE responding. Any
      // upstream response slower than 3 s made the reply fail with "10062 Unknown
      // interaction" as an unhandled rejection: the message froze on the previous
      // question while the session had already advanced, so every later answer was
      // applied to the wrong step.
      await i.deferUpdate().catch(() => {});

      const action = i.customId.split(':')[2] as AnswerId | 'stop' | 'correct' | 'wrong';

      // ── Give up ───────────────────────────────────────────────────────────
      if (action === 'stop') {
        await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
        const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# 🔮 Game Over',
          `You gave up after **${questionNo}** question${questionNo !== 1 ? 's' : ''}.`,
          '-# Run `/akinator` to play again.',
        ].join('\n')));
        await endWith(i, c);
        return;
      }

      // ── Akinator guessed correctly ────────────────────────────────────────
      if (action === 'correct') {
        await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
        // Akinator winning is still a completed game for the player, and the
        // reward acknowledges the time spent.
        await UserManager.creditWallet(interaction.user.id, WIN_REWARD);
        await UserManager.recordTransaction(interaction.user.id, 'akinator', WIN_REWARD, 'Akinator game completed');
        const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# 🔮 Guessed it!',
          `Akinator got it in **${questionNo}** question${questionNo !== 1 ? 's' : ''}.`,
          `You earned **${fmt.coins(WIN_REWARD)}** for finishing the game.`,
        ].join('\n')));
        await endWith(i, c);
        return;
      }

      // ── Reject the guess, or answer a question ────────────────────────────
      try {
        if (action === 'wrong') {
          // Rejections are counted too. questionNo was only incremented on the
          // answer branch while the hard stop below tested questionNo, so holding
          // "Keep guessing" issued unlimited requests to akinator.com without ever
          // advancing the counter.
          rejections++;
          if (rejections > MAX_REJECTIONS) {
            await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
            const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
              '# 🔮 I give up!',
              `That's ${MAX_REJECTIONS} rejected guesses — you win!`,
            ].join('\n')));
            await endWith(i, c);
            return;
          }
          turn = await AkinatorService.reject(session);
        } else {
          turn = await AkinatorService.answer(session, action);
          questionNo++;
        }
      } catch (err) {
        const aki = err as AkinatorError;
        logger.warn(`[Akinator] Turn failed: ${aki.message}`);
        const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# 🔮 Game Interrupted',
          aki.message,
          '-# Your progress could not be recovered — run `/akinator` to start over.',
        ].join('\n')));
        await endWith(i, c);
        return;
      }

      // Hard stop so a misbehaving session can't loop indefinitely.
      if (questionNo > MAX_QUESTIONS) {
        await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
        const c = new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# 🔮 I give up!',
          `After ${MAX_QUESTIONS} questions I still can't work it out. You win!`,
        ].join('\n')));
        await endWith(i, c);
        return;
      }

      await push(i, turn);
    });

    collector.on('end', async (_c: unknown, reason: string) => {
      if (finished) return;
      // Disable the controls so an expired game doesn't look playable.
      const c = withControls(turn, true);
      c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          reason === 'idle'
            ? '-# Timed out waiting for an answer.'
            : '-# Game expired.',
        ));
      await interaction.editReply({ components: [c] } as never).catch(() => {});
    });
  },
});
