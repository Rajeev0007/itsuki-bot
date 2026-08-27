import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import AnimeService, { type AnimeServiceError } from '../../services/AnimeService';
import * as CB from '../../builders/ComponentBuilder';

export default new Command({
  data: new SlashCommandBuilder()
    .setName('anime').setDescription('Search for an anime on MyAnimeList.')
    .addStringOption((o) => o.setName('query').setDescription('Anime title').setRequired(true)),
  category: 'anime', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const query = interaction.options.getString('query');
    if (!query) return interaction.editReply({ ...CB.errorResponse('Missing Query', 'Give me an anime title to search for.') } as never);
    // A rate limit or an outage is NOT "not found" — telling someone their
    // correctly-spelled title does not exist is the one answer guaranteed to be
    // wrong, and it used to be what they got for any failure.
    let results;
    try {
      results = await AnimeService.searchAnime(query);
    } catch (err) {
      const kind = (err as AnimeServiceError).kind;
      return interaction.editReply({
        ...CB.errorResponse(
          kind === 'rate_limited' ? 'Slow Down' : 'Search Unavailable',
          (err as Error).message,
        ),
      } as never);
    }
    if (!results.length) {
      return interaction.editReply({
        ...CB.errorResponse('Not Found', `No anime matched **${query}**. Check the spelling, or try the English title.`),
      } as never);
    }
    const anime = results[0];
    const genres = anime.genres?.map((g) => g.name).join(', ') || 'Unknown';
    const studios = anime.studios?.map((s) => s.name).join(', ') || 'Unknown';
    const synopsis = anime.synopsis ? (anime.synopsis.length > 500 ? anime.synopsis.slice(0, 497) + '…' : anime.synopsis) : 'No synopsis available.';
    const c = new ContainerBuilder()
      .addSectionComponents(new SectionBuilder().addTextDisplayComponents(
        // `title` is typed non-optional but never validated; a payload without it
        // rendered the literal heading "# undefined".
        new TextDisplayBuilder().setContent([`# ${anime.title || anime.title_english || 'Unknown title'}`, anime.title_english && anime.title_english !== anime.title ? `*${anime.title_english}*` : ''].filter(Boolean).join('\n'))
      ).setThumbnailAccessory(new ThumbnailBuilder().setURL(anime.images?.jpg?.image_url ?? 'https://i.imgur.com/AfFp7pu.png')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent([
        `${anime.score ?? 'N/A'}/10 • ${anime.status ?? 'Unknown'} • ${anime.episodes ?? '?'} eps`,
        `**Genres:** ${genres}`, `**Studio:** ${studios}`, `**Aired:** ${anime.aired?.string ?? 'Unknown'}`, '', `> ${synopsis}`,
      ].join('\n')))
      .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# MAL ID: ${anime.mal_id} • Rank: #${anime.rank ?? '?'}`));
    // setURL() throws on an undefined/invalid URL, which Jikan does occasionally
    // omit — that would take down the whole command instead of one button.
    if (typeof anime.url === 'string' && /^https?:\/\//i.test(anime.url)) {
      c.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel('View on MAL').setStyle(ButtonStyle.Link).setURL(anime.url),
        ),
      );
    }
    await interaction.editReply({ components: [c] });
  },
});
