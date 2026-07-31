/**
 * @file config.ts
 * @description Central configuration for the Discord bot.
 */

const config = {
  /* Bot Meta */
  token: process.env.DISCORD_TOKEN ?? '',
  clientId: process.env.DISCORD_CLIENT_ID ?? '',
  guildId: process.env.DISCORD_GUILD_ID ?? '',
  /** Prefix for message-based commands. Override with PREFIX env var. */
  prefix: process.env.PREFIX ?? ',',

  /* Presence */
  presence: {
    status: 'idle' as const,
    activities: [
      { name: '/help | ,help', type: 3 },
      { name: '/play loving you ', type: 3 },
      { name: '/kiss @you', type: 3 },
    ],
    activityInterval: 30_000,
  },

  /* Bot Meta */
  bot: {
    name: 'Itsuki Bot',
    version: '1.0.0',
    prefix: '/',
  },

  /* Colours (hex) */
  colors: {
    primary: 0x5865F2,
    success: 0x57F287,
    warning: 0xFEE75C,
    danger: 0xED4245,
    info: 0x5865F2,
    gold: 0xFFD700,
    purple: 0x9B59B6,
    teal: 0x1ABC9C,
    dark: 0x2C2F33,
    white: 0xFFFFFF,
    social: 0xFF69B4,
    anime: 0xFF4081,
  },

  /* Economy Balancing */
  economy: {
    startingBalance: 500,
    startingBank: 0,
    bankLimit: 1_000_000,
    maxWallet: 10_000_000,
    currency: '<:itsukiCoin:1527226118598426675>',
    currencyName: 'coins',

    daily: { min: 500, max: 1_500 },
    weekly: { min: 5_000, max: 15_000 },
    monthly: { min: 25_000, max: 75_000 },
    yearly: { min: 500_000, max: 1_500_000 },

    workJobs: [
      { name: 'Software Engineer', min: 800, max: 2_000 },
      { name: 'Chef', min: 400, max: 1_200 },
      { name: 'Doctor', min: 1_200, max: 3_000 },
      { name: 'Driver', min: 300, max: 900 },
      { name: 'Teacher', min: 500, max: 1_500 },
      { name: 'Artist', min: 350, max: 1_100 },
      { name: 'Firefighter', min: 900, max: 2_200 },
      { name: 'Mechanic', min: 600, max: 1_800 },
      { name: 'Nurse', min: 700, max: 1_900 },
      { name: 'Lawyer', min: 1_500, max: 4_000 },
    ],

    crimeSuccessRate: 0.55,
    crimeRewards: { min: 800, max: 3_000 },
    crimeFines: { min: 200, max: 1_000 },

    begChance: 0.70,
    begRewards: { min: 10, max: 300 },

    robChance: 0.40,
    robPercent: { min: 0.05, max: 0.25 },
    robMinWallet: 500,
    robFine: { min: 200, max: 600 },

    searchLocations: [
      'the couch cushions', 'an old jacket', 'the parking lot',
      'a dumpster', 'the library', 'under your bed', 'a vending machine',
      'the trash', 'a public fountain', 'the laundromat',
    ],
    searchRewards: { min: 50, max: 500 },
    searchFailChance: 0.30,

    xpPerCommand: { min: 5, max: 25 },
    xpToLevelUp: (level: number) => Math.floor(100 * Math.pow(1.5, level)),

    maxLevel: 100,
    prestigeBonus: 0.10,
  },

  /* Cooldowns (ms) */
  cooldowns: {
    daily: 86_400_000,
    weekly: 604_800_000,
    monthly: 2_592_000_000,
    yearly: 31_536_000_000,
    work: 3_600_000,
    crime: 1_800_000,
    rob: 3_600_000,
    beg: 60_000,
    search: 120_000,
    hunt: 1_800_000,
    fish: 1_800_000,
    mine: 3_600_000,
    farm: 7_200_000,
    chop: 3_600_000,
    social: 5_000,
    gamble: 3_000,
    slots: 5_000,
    coinflip: 3_000,
    blackjack: 10_000,
    roulette: 10_000,
    crash: 15_000,
    mines: 15_000,
    dice: 3_000,
  } as Record<string, number>,

  /* Gambling */
  gambling: {
    minBet: 10,
    maxBet: 100_000,
    houseEdge: 0.05,

    slots: {
      symbols: ['[C]', '[L]', '[O]', '[G]', '[B]', '[7]', '[D]', '[S]'],
      weights: [30, 25, 20, 15, 5, 3, 1, 1],
      payouts: {
        '[C][C][C]': 2, '[L][L][L]': 3, '[O][O][O]': 4,
        '[G][G][G]': 5, '[B][B][B]': 10, '[7][7][7]': 20,
        '[D][D][D]': 50, '[S][S][S]': 100,
      } as Record<string, number>,
      twoMatch: 0.5,
    },

    blackjack: {
      blackjackPayout: 1.5,
      dealerStandsAt: 17,
    },

    roulette: {
      numbers: Array.from({ length: 37 }, (_, i) => i),
      reds: [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36],
    },

    crash: {
      minMultiplier: 1.0,
      maxMultiplier: 100.0,
      houseEdge: 0.04,
    },
  },

  /* Anime */
  anime: {
    cardRarities: ['Common', 'Rare', 'Epic', 'Legendary', 'Mythic', 'Limited'] as const,
    rarityWeights: [50, 25, 15, 7, 2, 1],
    rarityColors: {
      Common: 0xAAAAAA,
      Rare: 0x3498DB,
      Epic: 0x9B59B6,
      Legendary: 0xFFD700,
      Mythic: 0xFF6B6B,
      Limited: 0xFF69B4,
    },
    rarityEmojis: {
      Common: '', Rare: '', Epic: '',
      Legendary: '', Mythic: '', Limited: '',
    },
  },

  /* Pets */
  pets: {
    adoptCost: 1_000,
    types: [
      { id: 'cat', name: 'Cat', rarity: 'Common', baseBonus: 0.02 },
      { id: 'dog', name: 'Dog', rarity: 'Common', baseBonus: 0.02 },
      { id: 'fox', name: 'Fox', rarity: 'Rare', baseBonus: 0.05 },
      { id: 'wolf', name: 'Wolf', rarity: 'Rare', baseBonus: 0.05 },
      { id: 'dragon', name: 'Dragon', rarity: 'Legendary', baseBonus: 0.15 },
      { id: 'unicorn', name: 'Unicorn', rarity: 'Mythic', baseBonus: 0.20 },
    ],
    feedCost: 50,
    trainCost: 100,
    feedCooldown: 3_600_000,
    trainCooldown: 7_200_000,
  },

  /* Shop */
  shop: {
    items: [
      { id: 'fishing_rod', name: 'Fishing Rod', price: 1_000, category: 'Tools', description: 'Required to go fishing.' },
      { id: 'pickaxe', name: 'Pickaxe', price: 1_500, category: 'Tools', description: 'Required to mine.' },
      { id: 'axe', name: 'Axe', price: 1_200, category: 'Tools', description: 'Required to chop wood.' },
      { id: 'hunting_rifle', name: 'Hunting Rifle', price: 2_000, category: 'Weapons', description: 'Required to hunt.' },
      { id: 'bread', name: 'Bread', price: 50, category: 'Food', description: 'A loaf of bread.' },
      { id: 'apple', name: 'Apple', price: 30, category: 'Food', description: 'A fresh apple.' },
      { id: 'coffee', name: 'Coffee', price: 80, category: 'Food', description: 'Boosts your energy.' },
      { id: 'lucky_charm', name: 'Lucky Charm', price: 5_000, category: 'Collectibles',description: '+5% luck for 1 hour.' },
      { id: 'booster_2x', name: '2x Booster', price: 10_000, category: 'Boosters', description: 'Double earnings for 30 min.' },
      { id: 'crate_common', name: 'Common Crate', price: 500, category: 'Crates', description: 'Contains a random Common item.' },
      { id: 'crate_rare', name: 'Rare Crate', price: 2_500, category: 'Crates', description: 'Contains a random Rare item.' },
      { id: 'crate_epic', name: 'Epic Crate', price: 10_000, category: 'Crates', description: 'Contains a random Epic item.' },
      { id: 'pet_egg', name: 'Pet Egg', price: 3_000, category: 'Pets', description: 'Hatch a random pet.' },
    ],
  },

  /* Anime card game */
  cards: {
    /** Cooldown between /roll draws. */
    rollCooldown: 60_000,
    /** How long a rolled card stays claimable. */
    claimWindow: 45_000,
    /** Cards shown per /collection page. */
    perPage: 9,
    /** Max simultaneous auction listings per user. */
    maxListings: 5,
    /** Coins awarded to a battle winner. */
    battleReward: { min: 250, max: 1_200 },
    battleCooldown: 120_000,
  },

  /* Achievements */
  achievements: {
    firstBalance: { id: 'first_balance', name: 'First Look', desc: 'Check your balance for the first time.', reward: 100 },
    firstDaily: { id: 'first_daily', name: 'Routine Starter', desc: 'Claim your first daily reward.', reward: 200 },
    richie: { id: 'richie', name: 'Richie Rich', desc: 'Have 100,000 coins in your wallet.', reward: 1000 },
    gamblingAddict: { id: 'gambling_addict', name: 'High Roller', desc: 'Win 50 gambling games.', reward: 500 },
    socialButterfly:{ id: 'social_butterfly',name: 'Social Butterfly', desc: 'Use 100 social action commands.', reward: 300 },
    animeCollector: { id: 'anime_collector', name: 'Card Collector', desc: 'Collect 10 anime cards.', reward: 500 },
    crimeLord: { id: 'crime_lord', name: 'Crime Lord', desc: 'Successfully commit 25 crimes.', reward: 750 },
    level10: { id: 'level_10', name: 'Rising Star', desc: 'Reach level 10.', reward: 500 },
    level50: { id: 'level_50', name: 'Veteran', desc: 'Reach level 50.', reward: 2500 },
    level100: { id: 'level_100', name: 'Legend', desc: 'Reach the max level of 100.', reward: 10000 },
    firstPrestige: { id: 'first_prestige', name: 'Reborn', desc: 'Prestige for the first time.', reward: 5000 },
    fisherman: { id: 'fisherman', name: 'Master Angler', desc: 'Fish 50 times.', reward: 400 },
    miner: { id: 'miner', name: 'Mining Pro', desc: 'Mine 50 times.', reward: 400 },
    petOwner: { id: 'pet_owner', name: 'Pet Lover', desc: 'Own your first pet.', reward: 300 },
    bankFull: { id: 'bank_full', name: 'Banker', desc: 'Fill your bank to the limit.', reward: 2000 },
  } as Record<string, { id: string; name: string; desc: string; reward: number }>,

  /* Logging */
  logging: {
    level: 'info',
    logFile: 'logs/bot.log',
  },

  /* Owners */
  owners: (process.env.BOT_OWNERS ?? '').split(',').map((id) => id.trim()).filter(Boolean),

  /**
   * Register commands for account-level installs ("Add to my apps") as well as
   * server installs.
   *
   * This must ALSO be enabled in the Discord Developer Portal under
   * Installation → Installation Contexts → User Install. If it is not, Discord
   * rejects the registration and AutoDeploy retries without it, logging what to
   * change. Set USER_INSTALL=false to opt out entirely.
   */
  userInstall: process.env.USER_INSTALL !== 'false',

  /* Database */
  mongo: {
    /**
     * Connection string. Required — the bot refuses to start without it rather
     * than silently falling back to a local store, because a half-configured
     * database is how data gets written somewhere nobody looks.
     */
    uri: process.env.MONGO_URI ?? '',
    /**
     * Database name. A URI may already name a database; this only applies when
     * it does not.
     */
    dbName: process.env.MONGO_DB ?? 'itsuki',
    /**
     * Fail fast on a dead server instead of letting every command hang for the
     * driver's 30s default.
     */
    serverSelectionTimeoutMS: Number(process.env.MONGO_TIMEOUT_MS ?? 8000),
  },
};

export default config;
