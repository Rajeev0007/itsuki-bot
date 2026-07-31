import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import { Valorant, GameApiError } from '../../services/GameApiService';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

function explain(err: unknown): { title: string; body: string } {
  if (err instanceof GameApiError) {
    const title = err.kind === 'not_found' ? 'Not Found'
      : err.kind === 'unconfigured' ? 'Not Configured'
      : 'Lookup Failed';
    return { title, body: err.message };
  }
  logger.warn(`[valorant] Unexpected: ${(err as Error).message}`);
  return { title: 'Lookup Failed', body: 'Something went wrong reaching the Valorant API.' };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('valorant').setDescription('Valorant agents, weapons, maps and player stats.')
    .addSubcommand((s) => s.setName('agent').setDescription('Agent abilities and role')
      .addStringOption((o) => o.setName('name').setDescription('Agent name, e.g. Jett').setRequired(true)))
    .addSubcommand((s) => s.setName('weapon').setDescription('Weapon damage and cost')
      .addStringOption((o) => o.setName('name').setDescription('Weapon name, e.g. Vandal').setRequired(true)))
    .addSubcommand((s) => s.setName('map').setDescription('Map layout and minimap')
      .addStringOption((o) => o.setName('name').setDescription('Map name, e.g. Ascent').setRequired(true)))
    .addSubcommand((s) => s.setName('agents').setDescription('List every playable agent'))
    .addSubcommand((s) => s.setName('player').setDescription('Player rank and level (needs an API key)')
      .addStringOption((o) => o.setName('riot_id').setDescription('Riot ID as Name#Tag').setRequired(true))),
  category: 'gaming',
  aliases: ['val'],
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['agent', 'weapon', 'map', 'agents', 'player'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    try {
      // ── agent ─────────────────────────────────────────────────────────────
      if (sub === 'agent') {
        const agent = await Valorant.findAgent(interaction.options.getString('name') ?? '');
        const container = new ContainerBuilder()
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                `# ${agent.name}`,
                agent.role ? `-# Role: **${agent.role}**` : '',
                agent.description,
              ].filter(Boolean).join('\n')))
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(agent.iconUrl ?? 'https://media.valorant-api.com/agents/default.png')),
          );

        if (agent.abilities.length) {
          container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
              agent.abilities.map((ab) =>
                `**${ab.name}** *(${ab.slot})*\n> ${ab.description.slice(0, 240) || 'No description.'}`,
              ).join('\n\n'),
            ));
        }
        if (agent.portraitUrl) {
          container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(agent.portraitUrl)),
          );
        }
        return interaction.editReply({ components: [container] });
      }

      // ── weapon ────────────────────────────────────────────────────────────
      if (sub === 'weapon') {
        const w = await Valorant.findWeapon(interaction.options.getString('name') ?? '');
        const damageTable = w.damage.length
          ? w.damage.map((d) => `\`${d.range.padEnd(9)}\` head **${d.head}** · body **${d.body}** · leg **${d.leg}**`).join('\n')
          : '-# No damage data available.';

        const container = new ContainerBuilder()
          .addSectionComponents(
            new SectionBuilder()
              .addTextDisplayComponents(new TextDisplayBuilder().setContent([
                `# ${w.name}`,
                `-# ${w.category}`,
                w.cost !== null ? `**Cost:** ${fmt.number(w.cost)} creds` : '',
                w.magazine !== null ? `**Magazine:** ${w.magazine}` : '',
                w.fireRate !== null ? `**Fire rate:** ${w.fireRate}/s` : '',
              ].filter(Boolean).join('\n')))
              .setThumbnailAccessory(new ThumbnailBuilder().setURL(w.iconUrl ?? 'https://media.valorant-api.com/weapons/default.png')),
          )
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Damage by range**\n${damageTable}`));

        return interaction.editReply({ components: [container] });
      }

      // ── map ───────────────────────────────────────────────────────────────
      if (sub === 'map') {
        const m = await Valorant.findMap(interaction.options.getString('name') ?? '');
        const container = new ContainerBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent([
            `# ${m.name}`,
            m.coordinates ? `-# ${m.coordinates}` : '',
          ].filter(Boolean).join('\n')));

        // Minimap is the useful one; splash is decorative.
        const art = m.minimapUrl ?? m.splashUrl;
        if (art) {
          container.addMediaGalleryComponents(
            new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(art)),
          );
        }
        return interaction.editReply({ components: [container] });
      }

      // ── agents (list) ─────────────────────────────────────────────────────
      if (sub === 'agents') {
        const agents = await Valorant.getAgents();
        // Grouped by role, which is how players actually think about them.
        const byRole = new Map<string, string[]>();
        for (const a of agents) {
          const role = a.role ?? 'Unknown';
          if (!byRole.has(role)) byRole.set(role, []);
          byRole.get(role)!.push(a.name);
        }
        const lines = [...byRole.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([role, names]) => `**${role}** (${names.length})\n> ${names.sort().join(', ')}`);

        const container = new ContainerBuilder()
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            `# Valorant Agents\n-# ${agents.length} playable agents`,
          ))
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(lines.join('\n\n')))
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '-# `/valorant agent <name>` for abilities.',
          ));
        return interaction.editReply({ components: [container] });
      }

      // ── player ────────────────────────────────────────────────────────────
      const riotId = (interaction.options.getString('riot_id') ?? '').trim();
      // Riot IDs are Name#Tag; the tag is required to disambiguate.
      const hashIdx = riotId.lastIndexOf('#');
      if (hashIdx <= 0 || hashIdx === riotId.length - 1) {
        return interaction.editReply({ ...CB.errorResponse(
          'Invalid Riot ID', 'Use the `Name#Tag` format, e.g. `Player#EUW1`.',
        ) } as never);
      }

      const pName = riotId.slice(0, hashIdx);
      const pTag = riotId.slice(hashIdx + 1);
      const p = await Valorant.getPlayer(pName, pTag);
      // Match history is best-effort and returns [] when unavailable.
      const matches = await Valorant.getRecentMatches(p.region.toLowerCase(), pName, pTag, 5);

      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# ${p.name}#${p.tag}`,
          `-# Region **${p.region}** · Level **${fmt.number(p.level)}**`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '**Rank**',
          `> **Current:** ${p.rank ?? 'Unranked'}${p.rr !== null ? ` · ${p.rr}/100 RR` : ''}`,
          p.elo !== null ? `> **Elo:** ${fmt.number(p.elo)}` : '',
          p.peakRank ? `> **Peak:** ${p.peakRank}${p.peakSeason ? ` (${p.peakSeason.toUpperCase()})` : ''}` : '',
        ].filter(Boolean).join('\n')));

      if (matches.length) {
        // Aggregate the recent window — a single match says little.
        const totals = matches.reduce((acc, m) => ({
          k: acc.k + m.kills, d: acc.d + m.deaths, a: acc.a + m.assists,
          hs: acc.hs + m.headshots, shots: acc.shots + m.headshots + m.bodyshots + m.legshots,
          wins: acc.wins + (m.won === true ? 1 : 0),
          acs: acc.acs + (m.acs ?? 0),
        }), { k: 0, d: 0, a: 0, hs: 0, shots: 0, wins: 0, acs: 0 });

        const avgKd = totals.d > 0 ? (totals.k / totals.d).toFixed(2) : '—';
        const hsPct = totals.shots > 0 ? ((totals.hs / totals.shots) * 100).toFixed(1) : '—';
        const avgAcs = Math.round(totals.acs / matches.length);

        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent([
            `**Last ${matches.length} matches**`,
            `> **${totals.wins}W – ${matches.length - totals.wins}L** · K/D **${avgKd}** · HS **${hsPct}%** · ACS **${avgAcs}**`,
            '',
            ...matches.map((m) => {
              const badge = m.won === null ? '⬜' : m.won ? '🟢' : '🔴';
              return `> ${badge} **${m.agent}** on **${m.map}** — ${m.kills}/${m.deaths}/${m.assists}`
                + ` (${m.roundsWon}-${m.roundsLost})${m.acs !== null ? ` · ${m.acs} ACS` : ''}`;
            }),
          ].join('\n')));
      } else {
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(
            '-# No recent competitive matches available for this account.',
          ));
      }

      if (p.cardUrl) {
        container.addMediaGalleryComponents(
          new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(p.cardUrl)),
        );
      }
      return interaction.editReply({ components: [container] });
    } catch (err) {
      const { title, body } = explain(err);
      return interaction.editReply({ ...CB.errorResponse(title, body) } as never);
    }
  },
});
