import {
  SlashCommandBuilder, MessageFlags, ContainerBuilder, SectionBuilder,
  TextDisplayBuilder, SeparatorBuilder, SeparatorSpacingSize, ThumbnailBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { Command } from '../../structures/Command';
import { Steam, GameApiError } from '../../services/GameApiService';
import * as CB from '../../builders/ComponentBuilder';
import fmt from '../../utils/Formatter';
import logger from '../../utils/Logger';

/**
 * Static CS2 reference data.
 *
 * Kept local rather than fetched: Valve publishes no economy/damage API, and
 * these values change only with balance patches. Embedding them means the
 * weapon and map lookups work with no API key at all.
 */
const WEAPONS: Array<{
  name: string; category: string; price: number; damage: number;
  armorPen: number; fireRate: number; kills: number; note?: string;
}> = [
  { name: 'AK-47',      category: 'Rifle',   price: 2700, damage: 36, armorPen: 77.5, fireRate: 600, kills: 1, note: 'One-shot headshot through helmet' },
  { name: 'M4A4',       category: 'Rifle',   price: 3100, damage: 33, armorPen: 70,   fireRate: 666, kills: 1 },
  { name: 'M4A1-S',     category: 'Rifle',   price: 2900, damage: 38, armorPen: 70,   fireRate: 600, kills: 1, note: 'Suppressed, tighter spray' },
  { name: 'AWP',        category: 'Sniper',  price: 4750, damage: 115, armorPen: 97.5, fireRate: 41, kills: 1, note: 'One-shot kill to body' },
  { name: 'Desert Eagle', category: 'Pistol', price: 700, damage: 63, armorPen: 93.2, fireRate: 267, kills: 1, note: 'One-shot headshot' },
  { name: 'Glock-18',   category: 'Pistol',  price: 200,  damage: 30, armorPen: 47,   fireRate: 400, kills: 0 },
  { name: 'USP-S',      category: 'Pistol',  price: 200,  damage: 35, armorPen: 50.4, fireRate: 352, kills: 1, note: 'Headshot kill unarmoured' },
  { name: 'MP9',        category: 'SMG',     price: 1250, damage: 26, armorPen: 60,   fireRate: 857, kills: 0 },
  { name: 'P90',        category: 'SMG',     price: 2350, damage: 26, armorPen: 69,   fireRate: 857, kills: 0 },
  { name: 'Galil AR',   category: 'Rifle',   price: 1800, damage: 30, armorPen: 77.5, fireRate: 666, kills: 0 },
  { name: 'FAMAS',      category: 'Rifle',   price: 2050, damage: 30, armorPen: 70,   fireRate: 666, kills: 0 },
  { name: 'SSG 08',     category: 'Sniper',  price: 1700, damage: 88, armorPen: 85,   fireRate: 48,  kills: 0, note: 'Scout — one-shot headshot' },
  { name: 'Nova',       category: 'Shotgun', price: 1050, damage: 26, armorPen: 50,   fireRate: 84,  kills: 0 },
  { name: 'Negev',      category: 'LMG',     price: 1700, damage: 35, armorPen: 75,   fireRate: 800, kills: 0 },
];

const ACTIVE_DUTY = ['Ancient', 'Anubis', 'Dust II', 'Inferno', 'Mirage', 'Nuke', 'Train'];
const OTHER_MAPS = ['Overpass', 'Vertigo', 'Cache', 'Office', 'Italy'];

const PERSONA_STATES = ['Offline', 'Online', 'Busy', 'Away', 'Snooze', 'Looking to trade', 'Looking to play'];

function explain(err: unknown): { title: string; body: string } {
  if (err instanceof GameApiError) {
    const title = err.kind === 'not_found' ? 'Not Found'
      : err.kind === 'unconfigured' ? 'Not Configured'
      : 'Lookup Failed';
    return { title, body: err.message };
  }
  logger.warn(`[cs2] Unexpected: ${(err as Error).message}`);
  return { title: 'Lookup Failed', body: 'Something went wrong reaching the Steam API.' };
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('cs2').setDescription('Counter-Strike 2 stats and reference data.')
    .addSubcommand((s) => s.setName('stats').setDescription('Player stats (needs a Steam API key)')
      .addStringOption((o) => o.setName('steam').setDescription('SteamID64, profile name, or profile URL').setRequired(true)))
    .addSubcommand((s) => s.setName('weapon').setDescription('Weapon price and damage')
      .addStringOption((o) => o.setName('name').setDescription('e.g. AK-47').setRequired(true)))
    .addSubcommand((s) => s.setName('weapons').setDescription('Full weapon reference table'))
    .addSubcommand((s) => s.setName('maps').setDescription('Current map pool')),
  category: 'gaming',
  cooldown: 5_000,

  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as never });

    const sub = (interaction.options as { getSubcommand: () => string }).getSubcommand();
    const SUBCOMMANDS = ['stats', 'weapon', 'weapons', 'maps'];
    if (!SUBCOMMANDS.includes(sub)) {
      return interaction.editReply({ ...CB.errorResponse(
        'Unknown Subcommand', `Use one of: ${SUBCOMMANDS.map((s) => `\`${s}\``).join(', ')}.`,
      ) } as never);
    }

    // ── maps (keyless) ──────────────────────────────────────────────────────
    if (sub === 'maps') {
      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🔫 CS2 Map Pool'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Active Duty** (${ACTIVE_DUTY.length})`,
          `> ${ACTIVE_DUTY.join(' · ')}`,
          '',
          '**Other / rotation**',
          `> ${OTHER_MAPS.join(' · ')}`,
          '',
          '-# Active Duty is the competitive pool and changes with Valve map updates.',
        ].join('\n')));
      return interaction.editReply({ components: [c] });
    }

    // ── weapons table (keyless) ─────────────────────────────────────────────
    if (sub === 'weapons') {
      const byCategory = new Map<string, typeof WEAPONS>();
      for (const w of WEAPONS) {
        if (!byCategory.has(w.category)) byCategory.set(w.category, []);
        byCategory.get(w.category)!.push(w);
      }
      const sections = [...byCategory.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([cat, list]) => [
          `**${cat}**`,
          ...list
            .sort((a, b) => b.price - a.price)
            .map((w) => `> \`${String(w.price).padStart(4)}$\` **${w.name}** — ${w.damage} dmg, ${w.armorPen}% armour pen`),
        ].join('\n'));

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('# 🔫 CS2 Weapons'))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(sections.join('\n\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          '-# `/cs2 weapon <name>` for full detail. Base damage is unarmoured, at point blank.',
        ));
      return interaction.editReply({ components: [c] });
    }

    // ── single weapon (keyless) ─────────────────────────────────────────────
    if (sub === 'weapon') {
      const query = (interaction.options.getString('name') ?? '').trim().toLowerCase();
      const w = WEAPONS.find((x) => x.name.toLowerCase() === query)
        ?? WEAPONS.find((x) => x.name.toLowerCase().replace(/[-\s]/g, '') === query.replace(/[-\s]/g, ''))
        ?? WEAPONS.find((x) => x.name.toLowerCase().includes(query));

      if (!w) {
        return interaction.editReply({ ...CB.errorResponse(
          'Unknown Weapon',
          `No weapon matching \`${query}\`. Try \`/cs2 weapons\` for the full list.`,
        ) } as never);
      }

      const c = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# ${w.name}`,
          `-# ${w.category}`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Price:** $${fmt.number(w.price)}`,
          `**Base damage:** ${w.damage}`,
          `**Armour penetration:** ${w.armorPen}%`,
          `**Fire rate:** ${w.fireRate} RPM`,
          `**Kill reward:** $${w.kills ? 300 : 300}`,
          w.note ? `\n> ${w.note}` : '',
        ].filter(Boolean).join('\n')));
      return interaction.editReply({ components: [c] });
    }

    // ── player stats (needs STEAM_API_KEY) ──────────────────────────────────
    try {
      const input = (interaction.options.getString('steam') ?? '').trim();
      const steamId = await Steam.resolveSteamId(input);
      const profile = await Steam.getProfile(steamId);
      const stats = await Steam.getCs2Stats(steamId);

      const container = new ContainerBuilder()
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent([
              `# ${profile.name}`,
              `-# ${PERSONA_STATES[profile.state] ?? 'Unknown'}${profile.countryCode ? ` · ${profile.countryCode}` : ''}`,
              `**SteamID64:** \`${profile.steamId}\``,
              profile.createdAt ? `**Account created:** <t:${Math.floor(profile.createdAt / 1000)}:D>` : '',
            ].filter(Boolean).join('\n')))
            .setThumbnailAccessory(new ThumbnailBuilder().setURL(
              profile.avatarUrl ?? 'https://community.cloudflare.steamstatic.com/public/images/avatars/av_full.jpg',
            )),
        )
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true));

      if (!stats) {
        // Private game details are the norm, so explain rather than error.
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '**CS2 stats unavailable**',
          'This profile hides its game details, or has never played CS2.',
          '-# Steam → Profile → Privacy Settings → *Game details: Public*.',
        ].join('\n')));
      } else {
        // ── Core ──────────────────────────────────────────────────────────
        container.addTextDisplayComponents(new TextDisplayBuilder().setContent([
          '**Overall**',
          `> **K/D** ${stats.kd ?? '—'} · **HS%** ${stats.hsPercent ?? '—'}% · **Accuracy** ${stats.accuracy ?? '—'}%`,
          `> **Kills** ${fmt.number(stats.kills)} · **Deaths** ${fmt.number(stats.deaths)} · **MVPs** ${fmt.number(stats.mvps)}`,
          `> **Matches** ${fmt.number(stats.matchesWon)}/${fmt.number(stats.matchesPlayed)} won (${stats.matchWinRate ?? '—'}%)`,
          `> **Rounds** ${fmt.number(stats.rounds)} · **Hours** ${fmt.number(stats.timePlayedHours)}h`,
        ].join('\n')));

        // ── Weapons ───────────────────────────────────────────────────────
        if (stats.topWeapons.length) {
          const top = stats.topWeapons.slice(0, 6).map((w, i) =>
            `> \`${i + 1}.\` **${w.name}** — ${fmt.number(w.kills)} kills${w.accuracy !== null ? ` · ${w.accuracy}% acc` : ''}`,
          );
          container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
              `**Top weapons**\n${top.join('\n')}`,
            ));
        }

        // ── Maps ──────────────────────────────────────────────────────────
        if (stats.mapStats.length) {
          const maps = stats.mapStats.slice(0, 5).map((m) =>
            `> **${m.name}** — ${m.winRate ?? '—'}% win rate (${fmt.number(m.rounds)} rounds)`,
          );
          container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(
              `**Most played maps**\n${maps.join('\n')}`,
            ));
        }

        // ── Objectives and specials ───────────────────────────────────────
        container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent([
            '**Objectives & specials**',
            `> **Bombs** ${fmt.number(stats.bombsPlanted)} planted · ${fmt.number(stats.bombsDefused)} defused`,
            `> **Hostages rescued** ${fmt.number(stats.hostagesRescued)}`,
            `> **Knife** ${fmt.number(stats.knifeKills)} · **Grenade** ${fmt.number(stats.grenadeKills)} · **Molotov** ${fmt.number(stats.molotovKills)}`,
            `> **Dominations** ${fmt.number(stats.dominations)} · **Revenges** ${fmt.number(stats.revenges)}`,
          ].join('\n')));

        // ── Last match ────────────────────────────────────────────────────
        if (stats.lastMatch) {
          const lm = stats.lastMatch;
          container.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
            .addTextDisplayComponents(new TextDisplayBuilder().setContent([
              `**Last match** ${lm.won === null ? '' : lm.won ? '· 🟢 Won' : '· 🔴 Lost'}`,
              `> **${lm.kills}** / **${lm.deaths}** (K/D ${lm.kd ?? '—'}) · **${lm.mvps}** MVPs`,
              `> Score **${lm.tWins + lm.ctWins}** – **${Math.max(0, lm.rounds - lm.tWins - lm.ctWins)}** over ${lm.rounds} rounds`,
              lm.damage > 0 ? `> **${fmt.number(lm.damage)}** damage · $${fmt.number(lm.moneySpent)} spent` : '',
            ].filter(Boolean).join('\n')));
        }
      }

      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setLabel('Steam profile').setStyle(ButtonStyle.Link).setURL(profile.profileUrl),
        ),
      );

      return interaction.editReply({ components: [container] });
    } catch (err) {
      const { title, body } = explain(err);
      return interaction.editReply({ ...CB.errorResponse(title, body) } as never);
    }
  },
});
