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

      const p = await Valorant.getPlayer(riotId.slice(0, hashIdx), riotId.slice(hashIdx + 1));
      const container = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# ${p.name}#${p.tag}`,
          `-# Region **${p.region}**`,
          `**Level:** ${fmt.number(p.level)}`,
          `**Rank:** ${p.rank ?? 'Unranked'}`,
          p.rr !== null ? `**RR:** ${p.rr}/100` : '',
          p.elo !== null ? `**Elo:** ${fmt.number(p.elo)}` : '',
        ].filter(Boolean).join('\n')));

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
