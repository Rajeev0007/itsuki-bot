/**
 * @file Constants.ts
 * @description Shared constants, emoji maps, and static lookup tables.
 */

const COIN = '<:itsukiCoin:1527226118598426675>';

/**
 * Emoji used throughout the bot's messages.
 *
 * Every entry here except the coin was previously an empty string, so templates
 * like `# ${E.WALLET} Your Balance` rendered as "#  Your Balance" — a stray
 * double space in every heading and stat line across the whole bot. Standard
 * Unicode emoji are used so nothing depends on the bot's custom emoji being
 * uploaded to a given server.
 */
export const EMOJI = {
  WALLET: '👛', BANK: '🏦', COINS: COIN, GEM: '💎',
  ARROW_UP: '⬆️', ARROW_DOWN: '⬇️', TRANSFER: '💸',
  DEPOSIT: '📥', WITHDRAW: '📤', DAILY: '🎁', WEEKLY: '📅',
  WORK: '💼', CRIME: '🕵️', ROB: '🔫', BEG: '🥺',
  SEARCH: '🔍', FISH: '🎣', MINE: '⛏️', FARM: '🌾',
  CHOP: '🪓', HUNT: '🏹',

  LEVEL: '📈', XP: '✨', RANK: '🏅', BADGE: '🎖️',
  TITLE: '🏷️', PRESTIGE: '🌟', REP: '🤝',

  SLOTS: '🎰', DICE: '🎲', CARDS: '🃏', COINFLIP: COIN,
  ROULETTE: '🎡', WIN: '🎉', LOSE: '💀', JACKPOT: COIN,

  INVENTORY: '🎒', SHOP: '🏪', BUY: '🛒', KEY: '🔑',
  CRATE: '📦', BOOSTER: '🚀', FOOD: '🍞', WEAPON: '⚔️',
  TOOL: '🛠️',

  SUCCESS: '✅', ERROR: '❌', WARNING: '⚠️', INFO: 'ℹ️',
  LOADING: '⏳', CLOCK: '🕐', COOLDOWN: '⏰', LOCK: '🔒',
  CHECK: '☑️', STAR: '⭐', FIRE: '🔥', SHIELD: '🛡️',
  CROWN: '👑', SPARKLES: '✨', LIGHTNING: '⚡', CHART: '📊',
  TROPHY: '🏆',

  PAW: '🐾', PET: '🐶', EGG: '🥚', HEART: '❤️',
  HUG: '🤗', KISS: '😘', PAT: '🫳', SLAP: '👋',

  ANIME: '🌸', CARD: '🎴', WAIFU: '💮', COLLECTION: '📚',
  HOME: '🏠', BACK: '◀️', NEXT: '▶️', CLOSE: '✖️', REFRESH: '🔄',
} as const;

export const SUITS       = ['♠', '♥', '♦', '♣'] as const;
export const CARD_VALUES = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'] as const;

export const RARITY_COLORS: Record<string, number> = {
  Common: 0xAAAAAA, Rare: 0x3498DB, Epic: 0x9B59B6,
  Legendary: 0xFFD700, Mythic: 0xFF6B6B, Limited: 0xFF69B4,
};

export const MEDALS = ['🥇','🥈','🥉','`#4`','`#5`','`#6`','`#7`','`#8`','`#9`','`#10`'] as const;

export const COLLECTOR_TIMEOUT  = 60_000;
export const PAGINATION_TIMEOUT = 120_000;
export const MAX_INVENTORY_DISPLAY    = 20;
export const MAX_LEADERBOARD          = 10;
export const MAX_TRANSACTION_HISTORY  = 15;
