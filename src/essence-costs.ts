import essenceCostData from "./essence-costs.json" with { type: "json" };
import type { HypixelClient } from "./hypixelClient.js";
import { buildPriceBook, priceFor } from "./pricing.js";
import type { PriceBasis, PriceBook } from "./pricing.js";
import type { JsonObject } from "./types.js";
import { asNumber, compactObject } from "./utils.js";

// Authoritative upgrade-cost data (essence + coins + materials per star), bundled
// from the NotEnoughUpdates REPO `constants/essencecosts.json`. Each entry has an
// essence `type`, numeric star keys ("1".."10"/higher) giving the essence amount
// for that star, and an `items` map of extra per-star costs as "TOKEN:amount".
type EssenceCostEntry = {
  type?: string;
  items?: Record<string, string[]>;
  [star: string]: unknown;
};

const ESSENCE_COSTS = essenceCostData as Record<string, EssenceCostEntry>;
const SKYBLOCK_COIN_TOKEN = "SKYBLOCK_COIN";

export type EssenceUpgradeOptions = {
  itemId: string;
  fromStar?: number;
  toStar?: number;
  quantity?: number;
  priceWithBazaar?: boolean;
  priceBasis?: PriceBasis;
};

type PerStar = {
  star: number;
  essence: number;
  coins?: number;
  materials?: Record<string, number>;
};

type ComputedUpgrade = {
  found: boolean;
  itemId: string;
  essenceType?: string;
  essenceBazaarId?: string;
  maxStar?: number;
  fromStar?: number;
  toStar?: number;
  quantity?: number;
  requestedToStar?: number;
  totalEssence?: number;
  totalCoins?: number;
  materials?: Record<string, number>;
  perStar?: PerStar[];
  suggestions?: string[];
  note?: string;
  notes?: string[];
};

function parseToken(token: string): { id: string; amount: number } | undefined {
  const lastColon = token.lastIndexOf(":");
  if (lastColon < 0) {
    return undefined;
  }

  const id = token.slice(0, lastColon);
  const amount = Number.parseInt(token.slice(lastColon + 1), 10);
  if (!id || !Number.isFinite(amount)) {
    return undefined;
  }

  return { id, amount };
}

function starKeys(entry: EssenceCostEntry): number[] {
  return Object.keys(entry)
    .filter((key) => /^\d+$/.test(key))
    .map((key) => Number.parseInt(key, 10))
    .sort((a, b) => a - b);
}

function findSuggestions(query: string, limit = 8): string[] {
  const needle = query.toUpperCase();
  return Object.keys(ESSENCE_COSTS)
    .filter((id) => id.includes(needle))
    .slice(0, limit);
}

/**
 * Pure computation of the essence/coin/material cost to star up one item type
 * from `fromStar` to `toStar`. Returns `found: false` with suggestions when the
 * item is not in the dataset, so callers never report invented costs.
 */
export function computeEssenceUpgrade(options: EssenceUpgradeOptions): ComputedUpgrade {
  const itemId = options.itemId.toUpperCase();
  const entry = ESSENCE_COSTS[itemId];

  if (!entry) {
    const suggestions = findSuggestions(itemId);
    return {
      found: false,
      itemId,
      suggestions: suggestions.length ? suggestions : undefined,
      note: "No essence upgrade data for this item ID. It may not be star-upgradeable, or the ID may differ from the canonical SkyBlock ID."
    };
  }

  const stars = starKeys(entry);
  const maxStar = stars.length ? stars[stars.length - 1]! : 0;
  const quantity = Math.max(1, Math.floor(options.quantity ?? 1));
  const fromStar = Math.max(0, Math.min(Math.floor(options.fromStar ?? 0), maxStar));
  const requestedToStar = Math.floor(options.toStar ?? maxStar);
  const toStar = Math.max(fromStar, Math.min(requestedToStar, maxStar));

  const notes: string[] = [];
  if (requestedToStar > maxStar) {
    notes.push(
      `This dataset covers essence stars up to ${maxStar}. Stars beyond ${maxStar} (Master Stars) for this item are applied with Master Star items rather than essence and are not included.`
    );
  }

  const essenceType = entry.type;
  const essenceBazaarId = essenceType ? `ESSENCE_${essenceType.toUpperCase()}` : undefined;

  let totalEssence = 0;
  let totalCoins = 0;
  const materials: Record<string, number> = {};
  const perStar: PerStar[] = [];

  for (let star = fromStar + 1; star <= toStar; star++) {
    const essence = (asNumber(entry[String(star)]) ?? 0) * quantity;
    totalEssence += essence;

    let starCoins = 0;
    const starMaterials: Record<string, number> = {};

    for (const token of entry.items?.[String(star)] ?? []) {
      const parsed = parseToken(token);
      if (!parsed) {
        continue;
      }

      const amount = parsed.amount * quantity;
      if (parsed.id === SKYBLOCK_COIN_TOKEN) {
        starCoins += amount;
        totalCoins += amount;
      } else {
        starMaterials[parsed.id] = (starMaterials[parsed.id] ?? 0) + amount;
        materials[parsed.id] = (materials[parsed.id] ?? 0) + amount;
      }
    }

    perStar.push(
      compactObject({
        star,
        essence,
        coins: starCoins || undefined,
        materials: Object.keys(starMaterials).length ? starMaterials : undefined
      }) as PerStar
    );
  }

  return {
    found: true,
    itemId,
    essenceType,
    essenceBazaarId,
    maxStar,
    fromStar,
    toStar,
    requestedToStar: requestedToStar !== toStar ? requestedToStar : undefined,
    quantity,
    totalEssence,
    totalCoins,
    materials: Object.keys(materials).length ? materials : undefined,
    perStar,
    notes: notes.length ? notes : undefined
  };
}

/**
 * Computes an essence upgrade and, when `priceWithBazaar` is enabled, converts
 * essence + materials into an estimated coin cost using live Bazaar prices.
 */
export async function getEssenceUpgradeCost(client: HypixelClient, options: EssenceUpgradeOptions): Promise<JsonObject> {
  const computed = computeEssenceUpgrade(options);

  if (!computed.found) {
    return compactObject({ ...computed });
  }

  if (options.priceWithBazaar === false) {
    return compactObject({ ...computed });
  }

  const basis: PriceBasis = options.priceBasis ?? "buy";
  const priceBook = await buildPriceBook(client, { basis });
  const priced = priceComputedUpgrade(computed, priceBook);

  return compactObject({
    ...computed,
    pricing: compactObject({
      basis,
      essenceBazaarId: computed.essenceBazaarId,
      essenceCoinValue: priced.essenceCoinValue,
      materialCoinValue: priced.materialCoinValue,
      materialBreakdown: priced.materialBreakdown,
      upgradeCoins: (computed.totalCoins ?? 0) || undefined,
      estimatedTotalCoins: priced.estimatedTotalCoins,
      unpriced: priced.unpriced,
      disclaimer:
        "Estimate from live Bazaar prices (basis: " +
        basis +
        "). Excludes any items not on the Bazaar (listed under unpriced); coin costs are exact game values."
    })
  });
}

type PricedUpgrade = {
  estimatedTotalCoins: number;
  essenceCoinValue?: number;
  materialCoinValue?: number;
  materialBreakdown?: Record<string, number>;
  unpriced?: string[];
};

// Prices a computed upgrade against an already-built price book. Coin costs are
// exact; essence and materials are valued at Bazaar prices. Anything missing
// from the Bazaar is reported in `unpriced` rather than silently dropped.
function priceComputedUpgrade(computed: ComputedUpgrade, priceBook: PriceBook): PricedUpgrade {
  const unpriced: string[] = [];
  let essenceCoinValue: number | undefined;

  if (computed.essenceBazaarId && computed.totalEssence) {
    const unit = priceFor(priceBook, computed.essenceBazaarId);
    if (unit !== undefined) {
      essenceCoinValue = unit * computed.totalEssence;
    } else {
      unpriced.push(computed.essenceBazaarId);
    }
  }

  let materialCoinValue = 0;
  const materialBreakdown: Record<string, number> = {};
  for (const [id, amount] of Object.entries(computed.materials ?? {})) {
    const unit = priceFor(priceBook, id);
    if (unit === undefined) {
      unpriced.push(id);
      continue;
    }
    const value = unit * amount;
    materialBreakdown[id] = Math.round(value);
    materialCoinValue += value;
  }

  const directCoins = computed.totalCoins ?? 0;
  const estimatedTotal = directCoins + (essenceCoinValue ?? 0) + materialCoinValue;

  return {
    estimatedTotalCoins: Math.round(estimatedTotal),
    essenceCoinValue: essenceCoinValue !== undefined ? Math.round(essenceCoinValue) : undefined,
    materialCoinValue: Object.keys(materialBreakdown).length ? Math.round(materialCoinValue) : undefined,
    materialBreakdown: Object.keys(materialBreakdown).length ? materialBreakdown : undefined,
    unpriced: unpriced.length ? [...new Set(unpriced)] : undefined
  };
}

export type EquippedGearPiece = {
  skyblockId?: string;
  name?: string;
  dungeonStars?: number;
};

/**
 * Aggregates the remaining essence/coin cost to finish starring a set of
 * equipped gear pieces (to each item's max essence star), priced with live
 * Bazaar data. Pieces not in the essence dataset or already maxed are skipped.
 * Returns undefined when nothing is upgradeable.
 */
export async function summarizeEquippedEssenceUpgrades(
  client: HypixelClient,
  pieces: EquippedGearPiece[] | undefined,
  options?: { priceBasis?: PriceBasis }
): Promise<JsonObject | undefined> {
  if (!pieces?.length) {
    return undefined;
  }

  const basis: PriceBasis = options?.priceBasis ?? "buy";
  const priceBook = await buildPriceBook(client, { basis });

  const essenceByType: Record<string, number> = {};
  const materials: Record<string, number> = {};
  const perPiece: JsonObject[] = [];
  const unpriced = new Set<string>();
  let totalUpgradeCoins = 0;
  let estimatedTotalCoins = 0;

  for (const piece of pieces) {
    const id = piece.skyblockId;
    if (!id) {
      continue;
    }

    const computed = computeEssenceUpgrade({
      itemId: id,
      fromStar: piece.dungeonStars ?? 0,
      priceWithBazaar: false
    });

    if (!computed.found || !computed.totalEssence || computed.fromStar === computed.toStar) {
      continue;
    }

    const priced = priceComputedUpgrade(computed, priceBook);

    if (computed.essenceType) {
      essenceByType[computed.essenceType] = (essenceByType[computed.essenceType] ?? 0) + (computed.totalEssence ?? 0);
    }
    for (const [matId, amount] of Object.entries(computed.materials ?? {})) {
      materials[matId] = (materials[matId] ?? 0) + amount;
    }
    for (const id of priced.unpriced ?? []) {
      unpriced.add(id);
    }
    totalUpgradeCoins += computed.totalCoins ?? 0;
    estimatedTotalCoins += priced.estimatedTotalCoins;

    perPiece.push(
      compactObject({
        skyblockId: id,
        name: piece.name,
        fromStar: computed.fromStar,
        toStar: computed.toStar,
        essenceType: computed.essenceType,
        essence: computed.totalEssence,
        estimatedCoins: priced.estimatedTotalCoins
      })
    );
  }

  if (!perPiece.length) {
    return undefined;
  }

  return compactObject({
    priceBasis: basis,
    essenceByType,
    materials: Object.keys(materials).length ? materials : undefined,
    upgradeCoins: totalUpgradeCoins || undefined,
    estimatedTotalCoins,
    unpriced: unpriced.size ? [...unpriced] : undefined,
    perPiece,
    disclaimer:
      "Remaining cost to bring each equipped piece to its max essence star. Master Stars (item-based) excluded. Essence/material values are live-Bazaar estimates; coin costs are exact."
  });
}
