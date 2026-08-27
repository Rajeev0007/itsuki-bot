import {
  SlashCommandBuilder, MessageFlags, AttachmentBuilder, ContainerBuilder,
  MediaGalleryBuilder, MediaGalleryItemBuilder, TextDisplayBuilder,
  SeparatorBuilder, SeparatorSpacingSize, type ChatInputCommandInteraction,
} from 'discord.js';
import { Command }            from '../../structures/Command';
import UserManager            from '../../managers/UserManager';
import BadgeManager           from '../../managers/BadgeManager';
import { generateProfile }    from '../../services/ProfileCanvas';
import fmt                    from '../../utils/Formatter';
import ProgressBar            from '../../utils/ProgressBar';
import logger                 from '../../utils/Logger';

/**
 * Short-lived cache of the net-worth ranking used for the "RANK #n" pill.
 *
 * UserManager.getRank sorts the WHOLE economy collection in memory (there are no
 * indexes, so it is a full scan), which is fine for a leaderboard command but not
 * for something on every profile view. Memoising the ordering bounds it to one
 * scan a minute no matter how much profile traffic there is; a rank that is up to
 * 60 seconds stale is not worth a scan per card.
 */
const RANK_TTL_MS = 60_000;
let rankCache: { at: number; order: Map<string, number> } | null = null;

async function cachedRank(userId: string): Promise<number | null> {
  if (!rankCache || Date.now() - rankCache.at > RANK_TTL_MS) {
    const board = await UserManager.getLeaderboard('netWorth', 5000);
    rankCache = {
      at: Date.now(),
      order: new Map(board.map((entry, i) => [entry.userId, i + 1])),
    };
  }
  return rankCache.order.get(userId) ?? null;
}

export default new Command({
  data: new SlashCommandBuilder()
    .setName('profile').setDescription('View your profile card.')
    .addUserOption((o) => o.setName('user').setDescription('User to view')),
  category: 'profile', cooldown: 5000,
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.deferReply({ flags: MessageFlags.IsComponentsV2 as any });
    const target = interaction.options.get('user')?.user ?? interaction.user;

    const [user, eco] = await Promise.all([
      UserManager.getUser(target.id, interaction.guild?.id),
      UserManager.getEconomy(target.id),
    ]);
    // xpNeeded(level) is the XP required to go FROM this level to the next.
    // Passing level + 1 showed the *following* level's requirement, so the bar
    // never filled at the point the user actually levelled up.
    const xpNeeded = UserManager.xpNeeded(user.level);

    // Badges are resolved from the records already loaded above rather than
    // letting BadgeManager fetch them again.
    const badges = await BadgeManager.resolve(target.id, {
      level: user.level,
      prestige: user.prestige ?? 0,
      netWorth: eco.wallet + eco.bank,
      gamesWon: user.stats?.gamesWon ?? 0,
      achievements: user.achievements ?? [],
    });

    // Banner and accent colour only exist on a FETCHED user — the cached object
    // from an interaction option carries neither. Non-fatal: the card falls back
    // to an accent-coloured gradient header.
    const fetched = await target.fetch().catch(() => null);
    const rank = await cachedRank(target.id).catch(() => null);

    // The member's nickname is what people recognise in a server, so it leads and
    // the account handle goes underneath.
    const member = interaction.guild
      ? await interaction.guild.members.fetch(target.id).catch(() => null)
      : null;

    // `canvas` is a native module — if it failed to build, or an avatar fetch
    // times out, generateProfile throws. Rather than turning the whole command
    // into "An error occurred", fall back to a text card that shows the same
    // information.
    let pngBuffer: Buffer | null = null;
    try {
      pngBuffer = await generateProfile({
        username: target.username,
        displayName: member?.displayName ?? fetched?.displayName ?? null,
        avatarURL: target.displayAvatarURL({ extension: 'png', size: 256 }),
        bannerURL: fetched?.bannerURL?.({ extension: 'png', size: 1024 }) ?? null,
        accentColor: fetched?.hexAccentColor ?? null,
        level: user.level, xp: user.xp, xpNeeded, prestige: user.prestige ?? 0,
        wallet: eco.wallet, bank: eco.bank, gamesWon: user.stats?.gamesWon ?? 0,
        gamesPlayed: user.stats?.gamesPlayed ?? 0, title: user.title ?? 'Newcomer',
        memberSince: user.createdAt, rank,
        badges: badges.map((b) => ({ name: b.name, icon: b.icon, color: b.color })),
      });
    } catch (err) {
      logger.warn(`[profile] Card render failed, using text fallback: ${(err as Error).message}`);
    }

    // Listed under the card so the icons on it have names, and so the text
    // fallback is not missing information the image would have shown.
    const badgeLine = badges.length
      ? badges.map((b) => `${b.icon} ${b.name}`).join(' · ')
      : null;

    if (!pngBuffer) {
      const winRate = (user.stats?.gamesPlayed ?? 0) > 0
        ? Math.round(((user.stats?.gamesWon ?? 0) / (user.stats!.gamesPlayed)) * 100)
        : 0;
      const textCard = new ContainerBuilder()
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `# ${member?.displayName ?? target.username}`,
          `*${user.title ?? 'Newcomer'}*${user.prestige ? ` • Prestige ${user.prestige}` : ''}${rank ? ` • Rank #${rank}` : ''}`,
        ].join('\n')))
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Large).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent([
          `**Level:** ${user.level} — ${fmt.number(user.xp)} / ${fmt.number(xpNeeded)} XP`,
          ProgressBar.create(user.xp, xpNeeded, 14),
          '',
          `**Wallet:** ${fmt.coins(eco.wallet)}`,
          `**Bank:** ${fmt.coins(eco.bank)}`,
          `**Games:** ${fmt.number(user.stats?.gamesWon ?? 0)} won / ${fmt.number(user.stats?.gamesPlayed ?? 0)} played (${winRate}%)`,
        ].join('\n')));
      if (badgeLine) {
        textCard
          .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
          .addTextDisplayComponents(new TextDisplayBuilder().setContent(`**Badges**\n${badgeLine}`));
      }
      textCard
        .addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent('-# Image card unavailable — showing text instead.'));
      return interaction.editReply({ components: [textCard] });
    }

    const attachment = new AttachmentBuilder(pngBuffer, { name: 'profile.png' });
    const c = new ContainerBuilder()
      .addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL('attachment://profile.png')));
    if (badgeLine) {
      c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(true))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# **Badges** — ${badgeLine}`));
    } else {
      c.addSeparatorComponents(new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small).setDivider(false))
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(
          target.id === interaction.user.id ? '-# Your profile card' : `-# ${target.username}'s profile`,
        ));
    }
    await interaction.editReply({ files: [attachment], components: [c] });
  },
});
