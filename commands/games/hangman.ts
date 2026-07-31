import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, ActionRowBuilder,
  StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction, type ButtonInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import UserManager from '../../managers/UserManager';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';

const MAX_WRONG = 6;
const REWARD_PER_LETTER = 60;

/** Word bank grouped by category, so the hint is meaningful. */
const WORDS: Array<{ category: string; words: string[] }> = [
  { category: 'Anime', words: ['naruto','bleach','pokemon','evangelion','berserk','gintama','haikyuu','vinland','monogatari','chainsaw'] },
  { category: 'Programming', words: ['typescript','recursion','variable','compiler','database','function','iterator','debugger','asynchronous','repository'] },
  { category: 'Animals', words: ['penguin','elephant','giraffe','octopus','chameleon','platypus','armadillo','flamingo','porcupine','jellyfish'] },
  { category: 'Food', words: ['ramen','sushi','pancake','spaghetti','chocolate','pineapple','croissant','dumpling','avocado','cinnamon'] },
  { category: 'Space', words: ['galaxy','asteroid','nebula','satellite','telescope','supernova','gravity','meteorite','constellation','spacecraft'] },
];

const STAGES = [
  '```\n       \n       \n       \n       \n=======\n```',
  '```\n   |   \n   |   \n   |   \n   |   \n=======\n```',
  '```\n +---+ \n   |   \n   |   \n   |   \n=======\n```',
  '```\n +---+ \n O |   \n   |   \n   |   \n=======\n```',
  '```\n +---+ \n O |   \n/|  |  \n   |   \n=======\n```',
  '```\n +---+ \n O |   \n/|\\ |  \n   |   \n=======\n```',
  '```\n +---+ \n O |   \n/|\\ |  \n/ \\|   \n=======\n```',
];

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

function maskWord(word: string, guessed: Set<string>): string {
  return word.split('').map((ch) => (guessed.has(ch) ? ch.toUpperCase() : '\\_')).join(' ');
}

/**
 * Letter picker.
 *
 * 26 letters can't fit in buttons (25 components max), so they're split across
 * select menus of 13 with already-guessed letters removed — that also prevents
 * re-guessing the same letter.
 */
function letterRows(gameId: string, guessed: Set<string>, disabled: boolean): ActionRowBuilder<StringSelectMenuBuilder>[] {
  const remaining = ALPHABET.filter((l) => !guessed.has(l));
  const rows: ActionRowBuilder<StringSelectMenuBuilder>[] = [];

  for (let i = 0; i < remaining.length; i += 13) {
    const chunk = remaining.slice(i, i + 13);
    if (!chunk.length) continue;
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`hm_pick:${gameId}:${i}`)
        .setPlaceholder(`Letters ${chunk[0].toUpperCase()}–${chunk[chunk.length - 1].toUpperCase()}`)
        .setDisabled(disabled || chunk.length === 0)
        .addOptions(chunk.map((l) => ({ label: l.toUpperCase(), value: l }))),
    ));
  }
  return rows;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('hangman').setDescription('Guess the hidden word one letter at a time.')
    .addStringOption((o) => o.setName('category').setDescription('Pick a category')
      .addChoices(...WORDS.map((w) => ({ name: w.category, value: w.category })))),
  category: 'games',
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const requested = interaction.options.getString('category');
    const bank = requested
      ? WORDS.find((w) => w.category.toLowerCase() === requested.toLowerCase())
      : fmt.randomItem(WORDS);

    if (!bank) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Category', `Choose from: ${WORDS.map((w) => w.category).join(', ')}.`,
      ) } as never);
    }

    const word = fmt.randomItem(bank.words).toLowerCase();
    const unique = new Set(word.split(''));
    const guessed = new Set<string>();
    let wrong = 0;
    let finished = false;
    const gameId = `${interaction.user.id}${Date.now().toString(36)}`;

    const isWon = () => [...unique].every((ch) => guessed.has(ch));

    const render = (status: string, reveal = false, disabled = false) => {
      const wrongLetters = [...guessed].filter((l) => !unique.has(l)).sort();
      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '# 🪢 Hangman',
          `-# Category: **${bank.category}** · ${word.length} letters`,
        ].join('\n')))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(STAGES[Math.min(wrong, MAX_WRONG)]))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `## ${reveal ? word.toUpperCase().split('').join(' ') : maskWord(word, guessed)}`,
          `**Lives:** ${'❤️'.repeat(MAX_WRONG - wrong)}${'🖤'.repeat(wrong)}`,
          wrongLetters.length ? `**Missed:** ${wrongLetters.map((l) => l.toUpperCase()).join(' ')}` : '',
        ].filter(Boolean).join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(status));

      if (!disabled) {
        for (const row of letterRows(gameId, guessed, false)) c.addActionRowComponents(row);
        c.addActionRowComponents(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`hm_quit:${gameId}`)
            .setLabel('Give up').setStyle(ButtonStyle.Danger),
        ));
      }
      return c;
    };

    const msg = await interaction.editReply({
      components: [render('Pick a letter from the menus below.')],
    } as never);

    const collector = (msg as unknown as {
      createMessageComponentCollector: (o: {
        filter: (i: { customId: string; user: { id: string } }) => boolean; time: number; idle: number;
      }) => { on: (e: string, cb: (...a: never[]) => void) => void; stop: (r?: string) => void };
    }).createMessageComponentCollector({
      filter: (i) => (i.customId.startsWith(`hm_pick:${gameId}:`) || i.customId === `hm_quit:${gameId}`)
        && i.user.id === interaction.user.id,
      time: 10 * 60_000,
      idle: 3 * 60_000,
    });

    const finish = async (
      i: StringSelectMenuInteraction | ButtonInteraction | null,
      status: string, won: boolean, reveal: boolean,
    ) => {
      finished = true;
      collector.stop('done');

      await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
      let earned = 0;
      if (won) {
        await UserManager.incrementStat(interaction.user.id, 'gamesWon');
        // Longer words pay more, and remaining lives add a bonus.
        earned = word.length * REWARD_PER_LETTER + (MAX_WRONG - wrong) * 50;
        await UserManager.addWallet(interaction.user.id, earned);
        await UserManager.recordTransaction(interaction.user.id, 'hangman', earned, `Hangman: ${word}`);
      }

      const finalStatus = won ? `${status}\nEarned **${fmt.coins(earned)}**.` : status;
      const payload = { components: [render(finalStatus, reveal, true)] };
      if (i) await i.update(payload as never).catch(() => {});
      else await interaction.editReply(payload as never).catch(() => {});
    };

    collector.on('collect', async (i: StringSelectMenuInteraction & ButtonInteraction) => {
      if (finished) return;

      if (i.customId === `hm_quit:${gameId}`) {
        await finish(i, `## Gave up — the word was **${word.toUpperCase()}**.`, false, true);
        return;
      }

      const letter = i.values?.[0];
      // Guard the value: a letter outside a-z, or one already guessed, must not
      // consume a life.
      if (!letter || letter.length !== 1 || !ALPHABET.includes(letter)) return;
      if (guessed.has(letter)) {
        await i.reply({ content: `You already guessed **${letter.toUpperCase()}**.`, flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }

      guessed.add(letter);
      const hit = unique.has(letter);
      if (!hit) wrong++;

      if (isWon()) {
        await finish(i, `## 🎉 You got it — **${word.toUpperCase()}**!`, true, true);
        return;
      }
      if (wrong >= MAX_WRONG) {
        await finish(i, `## 💀 Out of lives — the word was **${word.toUpperCase()}**.`, false, true);
        return;
      }

      await i.update({
        components: [render(hit
          ? `**${letter.toUpperCase()}** is in the word!`
          : `**${letter.toUpperCase()}** isn't in the word.`)],
      } as never);
    });

    collector.on('end', async (_c: unknown, reason: string) => {
      if (finished) return;
      await UserManager.incrementStat(interaction.user.id, 'gamesPlayed');
      await interaction.editReply({
        components: [render(
          `-# ${reason === 'idle' ? 'Timed out' : 'Game expired'} — the word was **${word.toUpperCase()}**.`,
          true, true,
        )],
      } as never).catch(() => {});
    });
  },
});
