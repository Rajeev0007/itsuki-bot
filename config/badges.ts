/**
 * @file badges.ts
 * @description The badge catalogue rendered on profile cards.
 *
 * ── Two kinds of badge, one list ─────────────────────────────────────────────
 * `manual` badges are awarded by a bot owner with /badgeadmin and stored on the
 * user record. `automatic` badges are DERIVED from account state every time a
 * profile is drawn and are never stored.
 *
 * Keeping both in one registry is deliberate: the profile card, the owner tools
 * and the grant validation all read the same source, so a badge cannot exist on
 * a card without a name and description, and an owner cannot hand out a badge
 * the renderer knows nothing about.
 *
 * It also means an automatic badge can never be granted or revoked by hand —
 * BadgeManager refuses that explicitly rather than writing an id that the
 * derivation would override on the next render.
 *
 * ── Icons are emoji on purpose ───────────────────────────────────────────────
 * services/canvas/EmojiText draws emoji as composited Twemoji images, so an
 * emoji icon renders identically on every host without shipping custom art or
 * registering a font. Adding a badge is therefore a one-entry change here.
 */

export type BadgeSource = 'manual' | 'automatic';

/** Account state an automatic badge is tested against. */
export interface BadgeContext {
  level: number;
  prestige: number;
  netWorth: number;
  gamesWon: number;
  achievements: string[];
}

export interface BadgeDef {
  id: string;
  name: string;
  description: string;
  /** Emoji, drawn as an image by EmojiText. */
  icon: string;
  /** Tile accent, used for the border and glow on the card. */
  color: string;
  source: BadgeSource;
  /** Lower sorts first, so prestige/staff badges lead the row. */
  order: number;
  /** Only for `automatic` badges: does this account qualify right now? */
  qualifies?: (ctx: BadgeContext) => boolean;
}

/**
 * Every badge in the bot.
 *
 * Ordered roughly by prestige so the default card shows the most meaningful ones
 * first when a user has more than fits.
 */
export const BADGES: BadgeDef[] = [
  // ── Owner-granted: staff and recognition ──────────────────────────────────
  {
    id: 'developer',
    name: 'Developer',
    description: 'Builds and maintains the bot.',
    icon: '🛠️', color: '#5865f2', source: 'manual', order: 10,
  },
  {
    id: 'staff',
    name: 'Staff',
    description: 'Part of the official support team.',
    icon: '🛡️', color: '#3ba55c', source: 'manual', order: 20,
  },
  {
    id: 'partner',
    name: 'Partner',
    description: 'Runs an official partnered server.',
    icon: '🤝', color: '#eb459e', source: 'manual', order: 30,
  },
  {
    id: 'supporter',
    name: 'Supporter',
    description: 'Financially supports the bot.',
    icon: '💖', color: '#ff73b3', source: 'manual', order: 40,
  },
  {
    id: 'early',
    name: 'Early Supporter',
    description: 'Was here before it was popular.',
    icon: '🌱', color: '#57f287', source: 'manual', order: 50,
  },
  {
    id: 'bughunter',
    name: 'Bug Hunter',
    description: 'Reported a genuine, reproducible bug.',
    icon: '🐛', color: '#faa61a', source: 'manual', order: 60,
  },
  {
    id: 'contributor',
    name: 'Contributor',
    description: 'Contributed code, art or translations.',
    icon: '✨', color: '#00b0f4', source: 'manual', order: 70,
  },
  {
    id: 'vip',
    name: 'VIP',
    description: 'Granted VIP standing by the owners.',
    icon: '👑', color: '#ffd700', source: 'manual', order: 80,
  },
  {
    id: 'champion',
    name: 'Event Champion',
    description: 'Won an official community event.',
    icon: '🏆', color: '#ffd700', source: 'manual', order: 90,
  },
  {
    id: 'artist',
    name: 'Artist',
    description: 'Created artwork used by the bot.',
    icon: '🎨', color: '#e67e22', source: 'manual', order: 100,
  },

  // ── Automatic: earned through play ────────────────────────────────────────
  // These read state that is already maintained elsewhere (achievements are
  // granted by UserManager.checkAchievements) rather than re-implementing the
  // thresholds, so a badge cannot drift out of step with the achievement that
  // is supposed to back it.
  {
    id: 'prestiged',
    name: 'Reborn',
    description: 'Prestiged at least once.',
    icon: '🔮', color: '#9b59b6', source: 'automatic', order: 110,
    qualifies: (c) => c.prestige > 0,
  },
  {
    id: 'legend',
    name: 'Legend',
    description: 'Reached the maximum level.',
    icon: '🌟', color: '#ffd700', source: 'automatic', order: 120,
    qualifies: (c) => c.achievements.includes('level_100'),
  },
  {
    id: 'veteran',
    name: 'Veteran',
    description: 'Reached level 50.',
    icon: '🎖️', color: '#c27c0e', source: 'automatic', order: 130,
    // Excluded once Legend is held, so the card doesn't show three variations
    // of the same milestone.
    qualifies: (c) => c.achievements.includes('level_50') && !c.achievements.includes('level_100'),
  },
  {
    id: 'rising',
    name: 'Rising Star',
    description: 'Reached level 10.',
    icon: '⭐', color: '#f1c40f', source: 'automatic', order: 140,
    qualifies: (c) => c.achievements.includes('level_10')
      && !c.achievements.includes('level_50') && !c.achievements.includes('level_100'),
  },
  {
    id: 'tycoon',
    name: 'Tycoon',
    description: 'Held 100,000 coins in your wallet.',
    icon: '💰', color: '#2ecc71', source: 'automatic', order: 150,
    qualifies: (c) => c.achievements.includes('richie'),
  },
  {
    id: 'banker',
    name: 'Banker',
    description: 'Filled your bank to the limit.',
    icon: '🏦', color: '#1abc9c', source: 'automatic', order: 160,
    qualifies: (c) => c.achievements.includes('bank_full'),
  },
  {
    id: 'highroller',
    name: 'High Roller',
    description: 'Won 50 gambling games.',
    icon: '🎲', color: '#e74c3c', source: 'automatic', order: 170,
    qualifies: (c) => c.achievements.includes('gambling_addict'),
  },
  {
    id: 'crimelord',
    name: 'Crime Lord',
    description: 'Pulled off 25 successful crimes.',
    icon: '🕴️', color: '#34495e', source: 'automatic', order: 180,
    qualifies: (c) => c.achievements.includes('crime_lord'),
  },
  {
    id: 'collector',
    name: 'Collector',
    description: 'Collected 10 anime cards.',
    icon: '🃏', color: '#8e44ad', source: 'automatic', order: 190,
    qualifies: (c) => c.achievements.includes('anime_collector'),
  },
  {
    id: 'social',
    name: 'Social Butterfly',
    description: 'Used 100 social commands.',
    icon: '🦋', color: '#00b0f4', source: 'automatic', order: 200,
    qualifies: (c) => c.achievements.includes('social_butterfly'),
  },
  {
    id: 'petlover',
    name: 'Pet Lover',
    description: 'Adopted a pet.',
    icon: '🐾', color: '#e91e63', source: 'automatic', order: 210,
    qualifies: (c) => c.achievements.includes('pet_owner'),
  },
];

const BY_ID = new Map(BADGES.map((b) => [b.id, b]));

export function getBadge(id: string): BadgeDef | null {
  return BY_ID.get(id) ?? null;
}

/** Badges an owner is allowed to grant, in catalogue order. */
export function manualBadges(): BadgeDef[] {
  return BADGES.filter((b) => b.source === 'manual').sort((a, b) => a.order - b.order);
}

export function automaticBadges(): BadgeDef[] {
  return BADGES.filter((b) => b.source === 'automatic').sort((a, b) => a.order - b.order);
}

export default BADGES;
