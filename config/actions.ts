/**
 * @file actions.ts
 * @description The roleplay action catalogue — one entry per action.
 *
 * ── Why a registry ──────────────────────────────────────────────────────────
 * Every action's GIF category, wording and counters used to be spread across ten
 * near-identical command files. The upstream category name in particular was
 * IMPLIED by the command name, so an action whose nekos.best category is named
 * differently (or does not exist at all) silently fell back to an unrelated
 * reaction — which is why /bonk showed a slap.
 *
 * `category` is now declared explicitly and separately from `name`, so the GIF a
 * command shows is a stated fact rather than a coincidence of naming.
 *
 * ── The 100-command cap ─────────────────────────────────────────────────────
 * Discord allows 100 global chat-input commands and rejects the ENTIRE
 * registration when that is exceeded (see utils/AutoDeploy). The bot is at 92, so
 * only actions marked `standalone: true` get their own command; every other entry
 * is reachable through /action, which costs one slot no matter how many actions
 * exist. Promoting one is a one-word change here — check the headroom first.
 */

export interface ActionDef {
  /** Action id, and the /action choice value. Also the command name when standalone. */
  name: string;
  /**
   * The nekos.best category this action's GIFs come from.
   *
   * Usually identical to `name`, but stated separately so a rename upstream — or
   * an action we expose under a friendlier name — cannot silently change which
   * GIF is shown.
   */
  category: string;
  /**
   * Categories to try if `category` is not in the live catalogue.
   *
   * Only for actions with no true upstream equivalent, and only ever a
   * SEMANTICALLY EQUIVALENT substitute. An empty list is correct and preferred
   * over a misleading GIF: GifService returns null and the command posts without
   * one, which is honest, where the old chain quietly served a punch for a bonk.
   */
  fallbacks?: string[];
  /** Past tense used with a target: "hugged", "waved at". */
  pastTense: string;
  /** Noun plural for the counters: "hugs", "kisses". */
  plural: string;
  /**
   * Present tense for solo use ("is dancing"). Supplying this makes the target
   * optional, because the action reads naturally on its own.
   */
  soloText?: string;
  /** Shown in the slash description and the /action picker. */
  emoji: string;
  /** Does this action get its own slash command? See the cap note above. */
  standalone: boolean;
}

/**
 * Every action.
 *
 * `category` values are the nekos.best v2 endpoint names. GifService validates
 * them against the live catalogue at runtime and logs anything that does not
 * resolve, so a category removed upstream surfaces in the logs instead of as a
 * silently GIF-less command.
 */
export const ACTIONS: ActionDef[] = [
  /* ── Affection ─────────────────────────────────────────────────────────── */
  { name: 'hug',      category: 'hug',      pastTense: 'hugged',        plural: 'hugs',       emoji: '🤗', standalone: true },
  { name: 'kiss',     category: 'kiss',     pastTense: 'kissed',        plural: 'kisses',     emoji: '😘', standalone: true },
  { name: 'cuddle',   category: 'cuddle',   pastTense: 'cuddled',       plural: 'cuddles',    emoji: '🫂', standalone: true },
  { name: 'pat',      category: 'pat',      pastTense: 'patted',        plural: 'pats',       emoji: '🫴', standalone: true },
  { name: 'handhold', category: 'handhold', pastTense: 'held hands with', plural: 'handholds', emoji: '🤝', standalone: true },
  { name: 'peck',     category: 'peck',     pastTense: 'pecked',        plural: 'pecks',      emoji: '💋', standalone: false },
  { name: 'tickle',   category: 'tickle',   pastTense: 'tickled',       plural: 'tickles',    emoji: '🪶', standalone: true },
  { name: 'feed',     category: 'feed',     pastTense: 'fed',           plural: 'meals',      emoji: '🍰', standalone: false },
  { name: 'highfive', category: 'highfive', pastTense: 'high-fived',    plural: 'high fives', emoji: '🙌', standalone: true },

  /* ── Playful aggression ────────────────────────────────────────────────── */
  { name: 'slap',     category: 'slap',     pastTense: 'slapped',       plural: 'slaps',      emoji: '👋', standalone: true },
  { name: 'punch',    category: 'punch',    pastTense: 'punched',       plural: 'punches',    emoji: '👊', standalone: true },
  { name: 'kick',     category: 'kick',     pastTense: 'kicked',        plural: 'kicks',      emoji: '🦵', standalone: false },
  { name: 'bite',     category: 'bite',     pastTense: 'bit',           plural: 'bites',      emoji: '🦷', standalone: false },
  { name: 'poke',     category: 'poke',     pastTense: 'poked',         plural: 'pokes',      emoji: '👉', standalone: true },
  { name: 'shoot',    category: 'shoot',    pastTense: 'shot',          plural: 'shots',      emoji: '🔫', standalone: false },
  { name: 'yeet',     category: 'yeet',     pastTense: 'yeeted',        plural: 'yeets',      emoji: '💨', standalone: false },
  {
    name: 'bonk', category: 'bonk',
    // nekos.best has no `bonk` category. `punch` is the closest HIT reaction, and
    // it is declared here rather than assumed, so the substitution is visible.
    fallbacks: ['punch'],
    pastTense: 'bonked', plural: 'bonks', emoji: '🔨', standalone: true,
  },
  { name: 'baka',     category: 'baka',     pastTense: 'called',        plural: 'insults',    emoji: '💢', standalone: false },

  /* ── Expressions (solo-friendly) ───────────────────────────────────────── */
  { name: 'wave',     category: 'wave',     pastTense: 'waved at',      plural: 'waves',      soloText: 'is waving',      emoji: '👋', standalone: true },
  { name: 'dance',    category: 'dance',    pastTense: 'danced with',   plural: 'dances',     soloText: 'is dancing',     emoji: '💃', standalone: true },
  { name: 'cry',      category: 'cry',      pastTense: 'cried with',    plural: 'cries',      soloText: 'is crying',      emoji: '😢', standalone: true },
  { name: 'laugh',    category: 'laugh',    pastTense: 'laughed with',  plural: 'laughs',     soloText: 'is laughing',    emoji: '😂', standalone: false },
  { name: 'smile',    category: 'smile',    pastTense: 'smiled at',     plural: 'smiles',     soloText: 'is smiling',     emoji: '🙂', standalone: false },
  { name: 'blush',    category: 'blush',    pastTense: 'blushed at',    plural: 'blushes',    soloText: 'is blushing',    emoji: '☺️', standalone: false },
  { name: 'happy',    category: 'happy',    pastTense: 'celebrated with', plural: 'celebrations', soloText: 'is happy',   emoji: '😄', standalone: false },
  { name: 'pout',     category: 'pout',     pastTense: 'pouted at',     plural: 'pouts',      soloText: 'is pouting',     emoji: '😤', standalone: false },
  { name: 'wink',     category: 'wink',     pastTense: 'winked at',     plural: 'winks',      soloText: 'is winking',     emoji: '😉', standalone: false },
  { name: 'stare',    category: 'stare',    pastTense: 'stared at',     plural: 'stares',     soloText: 'is staring',     emoji: '👀', standalone: false },
  { name: 'sleep',    category: 'sleep',    pastTense: 'fell asleep on', plural: 'naps',      soloText: 'is sleeping',    emoji: '😴', standalone: false },
  { name: 'nod',      category: 'nod',      pastTense: 'nodded at',     plural: 'nods',       soloText: 'is nodding',     emoji: '🙂', standalone: false },
  { name: 'shrug',    category: 'shrug',    pastTense: 'shrugged at',   plural: 'shrugs',     soloText: 'is shrugging',   emoji: '🤷', standalone: false },
  { name: 'facepalm', category: 'facepalm', pastTense: 'facepalmed at', plural: 'facepalms',  soloText: 'is facepalming', emoji: '🤦', standalone: false },
  { name: 'thumbsup', category: 'thumbsup', pastTense: 'gave a thumbs up to', plural: 'thumbs ups', soloText: 'approves', emoji: '👍', standalone: false },
  { name: 'nom',      category: 'nom',      pastTense: 'nommed',        plural: 'noms',       soloText: 'is eating',      emoji: '🍜', standalone: false },
  { name: 'yawn',     category: 'yawn',     pastTense: 'yawned at',     plural: 'yawns',      soloText: 'is yawning',     emoji: '🥱', standalone: false },
  { name: 'think',    category: 'think',    pastTense: 'thought about', plural: 'thoughts',   soloText: 'is thinking',    emoji: '🤔', standalone: false },
  { name: 'bored',    category: 'bored',    pastTense: 'is bored of',   plural: 'sighs',      soloText: 'is bored',       emoji: '😐', standalone: false },
  { name: 'smug',     category: 'smug',     pastTense: 'smirked at',    plural: 'smirks',     soloText: 'looks smug',     emoji: '😏', standalone: false },
  { name: 'run',      category: 'run',      pastTense: 'ran to',        plural: 'runs',       soloText: 'is running',     emoji: '🏃', standalone: false },
  { name: 'lurk',     category: 'lurk',     pastTense: 'lurked around', plural: 'lurks',      soloText: 'is lurking',     emoji: '🫥', standalone: false },
];

const BY_NAME = new Map(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string | null | undefined): ActionDef | null {
  return BY_NAME.get(String(name ?? '').toLowerCase().trim()) ?? null;
}

/** Actions that get their own slash command. */
export function standaloneActions(): ActionDef[] {
  return ACTIONS.filter((a) => a.standalone);
}

/** Every action name, sorted — the /action picker's source. */
export function actionNames(): string[] {
  return ACTIONS.map((a) => a.name).sort();
}

export default ACTIONS;
