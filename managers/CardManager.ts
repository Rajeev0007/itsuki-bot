/**
 * @file CardManager.ts
 * @description Owns all card state: collections, upgrades, battles and the
 * auction house.
 *
 * Two rules are enforced here rather than in the commands, because getting them
 * wrong is how a card economy leaks value:
 *
 *  1. A card can only be in ONE place at a time. Listing it on the auction
 *     house removes it from the collection; cancelling or expiring returns it.
 *     Nothing may sell a card it no longer owns, and nothing may battle or
 *     upgrade a listed card.
 *  2. Every coin movement goes through UserManager, so wallet caps and the
 *     transaction history stay consistent with the rest of the economy.
 */

import { getStore } from '../database/Store';
import UserManager from './UserManager';
import CardService, { RARITIES, type CardTemplate, type Rarity } from '../services/CardService';
import config from '../config/config';
import logger from '../utils/Logger';

const cardsDB    = getStore('cards');
const auctionsDB = getStore('auctions');

/** A card as owned by a specific user. */
export interface OwnedCard {
  id: number;
  name: string;
  imageUrl: string;
  animeName: string | null;
  rarity: Rarity;
  favorites: number;
  baseAttack: number;
  baseHealth: number;
  /** Upgrade level, 1-based. */
  level: number;
  /** Extra copies claimed; feed into upgrades. */
  copies: number;
  claimedAt: number;
  /** Locked cards can't be sold or auctioned by accident. */
  locked?: boolean;
}

export interface AuctionListing {
  listingId: string;
  sellerId: string;
  card: OwnedCard;
  price: number;
  createdAt: number;
  expiresAt: number;
}

/**
 * Operation results.
 *
 * Written as a single optional-field shape rather than an `{ ok: true } |
 * { ok: false; reason }` union: this project compiles with `strict: false`, and
 * narrowing a union on a boolean discriminant is unreliable without
 * `strictNullChecks` — the compiler can't see `reason` on the refused branch.
 */
export interface UpgradeResult { ok: boolean; reason?: string; card?: OwnedCard; cost?: number; usedCopy?: boolean }
export interface ListingResult { ok: boolean; reason?: string; listing?: AuctionListing }
export interface CancelResult  { ok: boolean; reason?: string; card?: OwnedCard }

/** Level-scaled combat stats. Each level adds 8% of the base. */
export function effectiveStats(card: OwnedCard): { attack: number; health: number; power: number } {
  const level = Math.max(1, Number(card.level) || 1);
  const scale = 1 + (level - 1) * 0.08;
  const attack = Math.round((Number(card.baseAttack) || 0) * scale);
  const health = Math.round((Number(card.baseHealth) || 0) * scale);
  // Single comparable figure for sorting and auto-selecting a battle card.
  return { attack, health, power: attack * 2 + health };
}

/** Coin cost to take a card from its current level to the next. */
export function upgradeCost(card: OwnedCard): number {
  const level = Math.max(1, Number(card.level) || 1);
  const base = RARITIES[card.rarity]?.value ?? 250;
  return Math.floor(base * 0.4 * Math.pow(1.55, level - 1));
}

export const MAX_CARD_LEVEL = 10;
/** Auction listings expire so cards can't be parked out of circulation. */
export const AUCTION_DURATION_MS = 24 * 60 * 60 * 1000;

const CardManager = {
  // ── Collection ───────────────────────────────────────────────────────────

  async getCollection(userId: string): Promise<OwnedCard[]> {
    const raw = await cardsDB.get(`${userId}.cards`);
    if (!raw || typeof raw !== 'object') return [];
    return Object.values(raw as Record<string, OwnedCard>)
      .filter((c) => c && typeof c === 'object' && Number.isInteger(c.id));
  },

  async getCard(userId: string, cardId: number): Promise<OwnedCard | null> {
    const card = await cardsDB.get(`${userId}.cards.${cardId}`);
    return card && typeof card === 'object' ? card as OwnedCard : null;
  },

  /**
   * Adds a claimed card. A duplicate increments `copies` instead of creating a
   * second entry, which is what makes duplicates useful for upgrades rather
   * than clutter.
   */
  async addCard(userId: string, template: CardTemplate): Promise<{ card: OwnedCard; isDuplicate: boolean }> {
    await cardsDB.ensure(`${userId}`, { cards: {}, claimedTotal: 0 });
    const existing = await this.getCard(userId, template.id);

    if (existing) {
      const copies = (Number(existing.copies) || 0) + 1;
      await cardsDB.set(`${userId}.cards.${template.id}.copies`, copies);
      return { card: { ...existing, copies }, isDuplicate: true };
    }

    const card: OwnedCard = {
      id: template.id,
      name: template.name,
      imageUrl: template.imageUrl,
      animeName: template.animeName,
      rarity: template.rarity,
      favorites: template.favorites,
      baseAttack: template.baseAttack,
      baseHealth: template.baseHealth,
      level: 1,
      copies: 0,
      claimedAt: Date.now(),
    };
    await cardsDB.set(`${userId}.cards.${template.id}`, card);
    await cardsDB.add(`${userId}.claimedTotal`, 1);

    // Makes the previously unreachable "Card Collector" achievement earnable.
    const total = (await this.getCollection(userId)).length;
    if (total >= 10) await UserManager.grantAchievement(userId, 'anime_collector');

    return { card, isDuplicate: false };
  },

  async removeCard(userId: string, cardId: number): Promise<boolean> {
    const card = await this.getCard(userId, cardId);
    if (!card) return false;
    await cardsDB.delete(`${userId}.cards.${cardId}`);
    return true;
  },

  async setLocked(userId: string, cardId: number, locked: boolean): Promise<boolean> {
    const card = await this.getCard(userId, cardId);
    if (!card) return false;
    await cardsDB.set(`${userId}.cards.${cardId}.locked`, locked);
    return true;
  },

  /** Finds a card in a user's collection by id or (partial) name. */
  async findCard(userId: string, query: string): Promise<OwnedCard | null> {
    const collection = await this.getCollection(userId);
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return null;

    if (/^\d+$/.test(q)) {
      const byId = collection.find((c) => c.id === Number(q));
      if (byId) return byId;
    }
    // Prefer an exact name match before falling back to a substring, so
    // searching "Rin" doesn't surprise you with "Rintarou".
    return collection.find((c) => c.name.toLowerCase() === q)
      ?? collection.find((c) => c.name.toLowerCase().includes(q))
      ?? null;
  },

  // ── Roll cooldown ────────────────────────────────────────────────────────

  async getRollCooldown(userId: string): Promise<number> {
    const last = Number(await cardsDB.get(`${userId}.lastRoll`, 0)) || 0;
    const remaining = config.cards.rollCooldown - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
  },

  async markRolled(userId: string): Promise<void> {
    await cardsDB.ensure(`${userId}`, { cards: {}, claimedTotal: 0 });
    await cardsDB.set(`${userId}.lastRoll`, Date.now());
  },

  // ── Upgrades ─────────────────────────────────────────────────────────────

  /**
   * Levels a card up using coins, consuming a duplicate copy when available
   * (which halves the coin cost).
   */
  async upgrade(userId: string, cardId: number): Promise<UpgradeResult> {
    const card = await this.getCard(userId, cardId);
    if (!card) return { ok: false, reason: 'You do not own that card.' };

    const level = Math.max(1, Number(card.level) || 1);
    if (level >= MAX_CARD_LEVEL) {
      return { ok: false, reason: `**${card.name}** is already at the maximum level (${MAX_CARD_LEVEL}).` };
    }
    if (await this.isListed(userId, cardId)) {
      return { ok: false, reason: `**${card.name}** is listed on the auction house. Cancel the listing first.` };
    }

    const copies = Number(card.copies) || 0;
    const usedCopy = copies > 0;
    const cost = usedCopy ? Math.floor(upgradeCost(card) / 2) : upgradeCost(card);

    const { wallet } = await UserManager.getBalance(userId);
    if (wallet < cost) {
      return { ok: false, reason: `You need ${cost.toLocaleString('en-US')} coins to upgrade **${card.name}** (you have ${wallet.toLocaleString('en-US')}).` };
    }

    // Atomic charge: the balance check above is for the error message, this is
    // what actually gates the upgrade.
    if (!await UserManager.debitWallet(userId, cost)) {
      return { ok: false, reason: `You need ${cost.toLocaleString('en-US')} coins to upgrade **${card.name}**.` };
    }
    if (usedCopy) await cardsDB.set(`${userId}.cards.${cardId}.copies`, copies - 1);
    await cardsDB.set(`${userId}.cards.${cardId}.level`, level + 1);
    await UserManager.recordTransaction(userId, 'card_upgrade', -cost, `Upgraded ${card.name} to Lv.${level + 1}`);

    const updated = await this.getCard(userId, cardId);
    return { ok: true, card: updated ?? { ...card, level: level + 1 }, cost, usedCopy };
  },

  // ── Battle ───────────────────────────────────────────────────────────────

  /**
   * Simulates a turn-based duel between two cards.
   *
   * Damage carries +/-15% variance so identical decks aren't fully
   * deterministic, and the attacker order is decided by attack so the faster
   * card strikes first. Capped at 40 rounds — with high-HP legendaries and a
   * damage floor of 1 this can't loop forever, but the cap makes that explicit.
   */
  simulateBattle(a: OwnedCard, b: OwnedCard): {
    winner: 'a' | 'b';
    rounds: Array<{ attacker: 'a' | 'b'; damage: number; targetHpLeft: number }>;
  } {
    const sa = effectiveStats(a);
    const sb = effectiveStats(b);

    let hpA = sa.health;
    let hpB = sb.health;
    // Higher attack strikes first; ties go to A.
    let turn: 'a' | 'b' = sa.attack >= sb.attack ? 'a' : 'b';
    const rounds: Array<{ attacker: 'a' | 'b'; damage: number; targetHpLeft: number }> = [];

    for (let i = 0; i < 40 && hpA > 0 && hpB > 0; i++) {
      const attack = turn === 'a' ? sa.attack : sb.attack;
      const variance = 0.85 + Math.random() * 0.3;
      const damage = Math.max(1, Math.round(attack * variance));

      if (turn === 'a') { hpB = Math.max(0, hpB - damage); rounds.push({ attacker: 'a', damage, targetHpLeft: hpB }); }
      else              { hpA = Math.max(0, hpA - damage); rounds.push({ attacker: 'b', damage, targetHpLeft: hpA }); }

      turn = turn === 'a' ? 'b' : 'a';
    }

    // If the round cap is hit, whoever has more HP remaining wins.
    const winner: 'a' | 'b' = hpB <= 0 ? 'a' : hpA <= 0 ? 'b' : (hpA >= hpB ? 'a' : 'b');
    return { winner, rounds };
  },

  /** The user's strongest card, used when none is specified. */
  async strongestCard(userId: string): Promise<OwnedCard | null> {
    const collection = await this.getCollection(userId);
    if (!collection.length) return null;
    return collection.reduce((best, c) =>
      effectiveStats(c).power > effectiveStats(best).power ? c : best,
    );
  },

  // ── Auction house ────────────────────────────────────────────────────────

  async getListings(): Promise<AuctionListing[]> {
    const raw = await auctionsDB.get('listings');
    if (!raw || typeof raw !== 'object') return [];
    return Object.values(raw as Record<string, AuctionListing>)
      .filter((l) => l && typeof l === 'object' && l.card && typeof l.listingId === 'string');
  },

  /** True when this user currently has that card listed. */
  async isListed(userId: string, cardId: number): Promise<boolean> {
    const listings = await this.getListings();
    return listings.some((l) => l.sellerId === userId && l.card?.id === cardId);
  },

  /**
   * Lists a card. The card leaves the seller's collection immediately, so it
   * cannot be battled, upgraded or double-listed while on the market.
   */
  async listCard(userId: string, cardId: number, price: number): Promise<ListingResult> {
    const card = await this.getCard(userId, cardId);
    if (!card) return { ok: false, reason: 'You do not own that card.' };
    if (card.locked) return { ok: false, reason: `**${card.name}** is locked. Unlock it first with \`/card lock\`.` };

    const floor = Math.floor((RARITIES[card.rarity]?.value ?? 250) * 0.25);
    const asking = Math.floor(Number(price) || 0);
    if (asking < floor) {
      return { ok: false, reason: `Minimum price for a ${RARITIES[card.rarity]?.label ?? 'card'} is ${floor.toLocaleString('en-US')} coins.` };
    }
    if (asking > config.economy.maxWallet) {
      return { ok: false, reason: 'That price is unreasonably high.' };
    }

    const active = (await this.getListings()).filter((l) => l.sellerId === userId);
    if (active.length >= config.cards.maxListings) {
      return { ok: false, reason: `You already have ${config.cards.maxListings} active listings. Cancel one first.` };
    }

    const listing: AuctionListing = {
      listingId: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sellerId: userId,
      card,
      price: asking,
      createdAt: Date.now(),
      expiresAt: Date.now() + AUCTION_DURATION_MS,
    };

    // Escrow: remove from the collection before publishing the listing so the
    // card can never exist in both places.
    await this.removeCard(userId, cardId);
    await auctionsDB.set(`listings.${listing.listingId}`, listing);
    return { ok: true, listing };
  },

  async cancelListing(userId: string, listingId: string): Promise<CancelResult> {
    const listing = await auctionsDB.get(`listings.${listingId}`) as AuctionListing | undefined;
    if (!listing || typeof listing !== 'object') return { ok: false, reason: 'That listing does not exist.' };
    if (listing.sellerId !== userId) return { ok: false, reason: 'That listing is not yours.' };

    await auctionsDB.delete(`listings.${listingId}`);
    // Return the escrowed card.
    await cardsDB.ensure(`${userId}`, { cards: {}, claimedTotal: 0 });
    await cardsDB.set(`${userId}.cards.${listing.card.id}`, listing.card);
    return { ok: true, card: listing.card };
  },

  async buyListing(buyerId: string, listingId: string): Promise<ListingResult> {
    const listing = await auctionsDB.get(`listings.${listingId}`) as AuctionListing | undefined;
    if (!listing || typeof listing !== 'object') return { ok: false, reason: 'That listing no longer exists.' };
    if (listing.sellerId === buyerId) return { ok: false, reason: 'You cannot buy your own listing.' };

    const { wallet } = await UserManager.getBalance(buyerId);
    if (wallet < listing.price) {
      return { ok: false, reason: `You need ${listing.price.toLocaleString('en-US')} coins (you have ${wallet.toLocaleString('en-US')}).` };
    }

    // Delete first: if two buyers race, only the one that removes the listing
    // proceeds, so a card can't be sold twice.
    await auctionsDB.delete(`listings.${listingId}`);
    const stillGone = await auctionsDB.get(`listings.${listingId}`);
    if (stillGone) return { ok: false, reason: 'That listing was just bought by someone else.' };

    // The race guard above protected the CARD but not the money: the seller used
    // to be credited unconditionally, so a buyer whose wallet emptied after the
    // balance check paid nothing while the seller was still paid in full. Take
    // the money atomically and put the listing back if it fails.
    if (!await UserManager.debitWallet(buyerId, listing.price)) {
      await auctionsDB.set(`listings.${listingId}`, listing);
      return { ok: false, reason: `You need ${listing.price.toLocaleString('en-US')} coins to buy this.` };
    }
    await UserManager.creditWallet(listing.sellerId, listing.price);

    await cardsDB.ensure(`${buyerId}`, { cards: {}, claimedTotal: 0 });
    const existing = await this.getCard(buyerId, listing.card.id);
    if (existing) {
      // Buying a duplicate adds a copy rather than overwriting an upgraded card.
      await cardsDB.set(`${buyerId}.cards.${listing.card.id}.copies`, (Number(existing.copies) || 0) + 1);
    } else {
      await cardsDB.set(`${buyerId}.cards.${listing.card.id}`, { ...listing.card, locked: false });
    }

    await UserManager.recordTransaction(buyerId, 'card_buy', -listing.price, `Bought ${listing.card.name}`);
    await UserManager.recordTransaction(listing.sellerId, 'card_sell', listing.price, `Sold ${listing.card.name}`);
    return { ok: true, listing };
  },

  /** Returns expired listings to their sellers. Runs periodically. */
  async expireListings(): Promise<number> {
    const now = Date.now();
    const listings = await this.getListings();
    let returned = 0;
    for (const l of listings) {
      if (Number(l.expiresAt) > now) continue;
      try {
        await auctionsDB.delete(`listings.${l.listingId}`);
        await cardsDB.ensure(`${l.sellerId}`, { cards: {}, claimedTotal: 0 });
        await cardsDB.set(`${l.sellerId}.cards.${l.card.id}`, l.card);
        returned++;
      } catch (err) {
        logger.warn(`[Cards] Failed to expire listing ${l.listingId}: ${(err as Error).message}`);
      }
    }
    if (returned) logger.info(`[Cards] Returned ${returned} expired auction listing(s).`);
    return returned;
  },

  /**
   * Ranks collectors by total card power.
   *
   * Computed on demand rather than stored, because power changes with every
   * upgrade, claim and sale — a cached total would drift out of date.
   */
  async powerLeaderboard(limit = 10): Promise<Array<{ userId: string; value: number }>> {
    const entries = await cardsDB.all();
    return entries
      .filter(([, data]) => data !== null && typeof data === 'object')
      .map(([userId, data]) => {
        const cards = (data as { cards?: Record<string, OwnedCard> }).cards;
        if (!cards || typeof cards !== 'object') return { userId, value: 0 };
        let power = 0;
        for (const card of Object.values(cards)) {
          if (card && typeof card === 'object' && Number.isInteger(card.id)) {
            power += effectiveStats(card).power;
          }
        }
        return { userId, value: power };
      })
      .filter((e) => e.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  },

  /** Collection totals for the profile/stats surfaces. */
  async summarise(userId: string): Promise<{
    total: number; byRarity: Record<Rarity, number>; power: number; best: OwnedCard | null;
  }> {
    const collection = await this.getCollection(userId);
    const byRarity = { common: 0, uncommon: 0, rare: 0, epic: 0, legendary: 0 } as Record<Rarity, number>;
    let power = 0;
    let best: OwnedCard | null = null;

    for (const c of collection) {
      if (byRarity[c.rarity] !== undefined) byRarity[c.rarity]++;
      const stats = effectiveStats(c);
      power += stats.power;
      if (!best || stats.power > effectiveStats(best).power) best = c;
    }
    return { total: collection.length, byRarity, power, best };
  },
};

export { CardService };
export default CardManager;
