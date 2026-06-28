import reforges from "./reforges.json" with { type: "json" };
import { priceFor } from "./pricing.js";
import type { PriceBook } from "./pricing.js";
import type { DecodedInventoryItem } from "./types.js";

// Modifier valuation faithful to the SkyHelper-Networth methodology
// (https://github.com/Altpapier/SkyHelper-Networth). Every modifier is valued at
// a recognized "application worth" fraction of the live Bazaar price of the
// component item, so estimates match a widely used standard rather than guesses.
const APPLICATION_WORTH = {
  enchantments: 0.85,
  hotPotatoBook: 1,
  fumingPotatoBook: 0.6,
  recombobulator: 0.8,
  essence: 0.75,
  masterStar: 1,
  silex: 0.75,
  gemstone: 1,
  reforge: 1
} as const;

// Per-enchantment overrides (enchantments that should not count at the default 85%).
const ENCHANTMENTS_WORTH: Record<string, number> = {
  COUNTER_STRIKE: 0.2,
  BIG_BRAIN: 0.35,
  ULTIMATE_INFERNO: 0.35,
  OVERLOAD: 0.35,
  ULTIMATE_SOUL_EATER: 0.35,
  ULTIMATE_FATAL_TEMPO: 0.65
};

const BLOCKED_ENCHANTMENTS: Record<string, string[]> = {
  BONE_BOOMERANG: ["OVERLOAD", "POWER", "ULTIMATE_SOUL_EATER"],
  DEATH_BOW: ["OVERLOAD", "POWER", "ULTIMATE_SOUL_EATER"],
  GARDENING_AXE: ["REPLENISH"],
  GARDENING_HOE: ["REPLENISH"],
  ADVANCED_GARDENING_AXE: ["REPLENISH"],
  ADVANCED_GARDENING_HOE: ["REPLENISH"]
};

const IGNORED_ENCHANTMENTS: Record<string, number> = { SCAVENGER: 5 };
const STACKING_ENCHANTMENTS = new Set(["EXPERTISE", "COMPACT", "ABSORB", "CULTIVATING", "CHAMPION", "HECATOMB", "TOXOPHILITE"]);
const IGNORE_SILEX = new Set(["PROMISING_SPADE", "PROMISING_AXE"]);
const MASTER_STARS = ["FIRST_MASTER_STAR", "SECOND_MASTER_STAR", "THIRD_MASTER_STAR", "FOURTH_MASTER_STAR", "FIFTH_MASTER_STAR"];
const REFORGES = reforges as Record<string, string>;
const GENERIC_GEMSTONE_SLOTS = new Set(["COMBAT", "OFFENSIVE", "DEFENSIVE", "MINING", "UNIVERSAL", "CHISEL"]);
const ALLOWED_RECOMBOBULATED_CATEGORIES = new Set(["ACCESSORY", "NECKLACE", "GLOVES", "BRACELET", "BELT", "CLOAK", "VACUUM"]);
const ALLOWED_RECOMBOBULATED_IDS = new Set([
  "DIVAN_HELMET",
  "DIVAN_CHESTPLATE",
  "DIVAN_LEGGINGS",
  "DIVAN_BOOTS",
  "FERMENTO_HELMET",
  "FERMENTO_CHESTPLATE",
  "FERMENTO_LEGGINGS",
  "FERMENTO_BOOTS",
  "SHADOW_ASSASSIN_CLOAK",
  "STARRED_SHADOW_ASSASSIN_CLOAK"
]);

type UpgradeCost = { type?: string; essence_type?: string; item_id?: string; amount?: number };

export type ItemMeta = {
  category?: string;
  upgradeCosts?: UpgradeCost[][];
};

export type ModifierValue = {
  total: number;
  breakdown: Record<string, number>;
  unpriced: number;
};

function add(breakdown: Record<string, number>, key: string, value: number): void {
  if (value > 0) {
    breakdown[key] = (breakdown[key] ?? 0) + value;
  }
}

/**
 * Values the NBT modifiers on a single decoded item (enchantments, hot potato
 * books, recombobulator, essence/master stars, gemstones, reforges) using live
 * Bazaar prices.
 * Components missing from the price book are counted in `unpriced` rather than
 * silently assumed free, and never fabricated.
 */
export function valueItemModifiers(
  item: DecodedInventoryItem,
  priceBook: PriceBook,
  meta: ItemMeta | undefined
): ModifierValue {
  const breakdown: Record<string, number> = {};
  let total = 0;
  let unpriced = 0;
  const id = item.skyblockId?.toUpperCase();

  const price = (componentId: string): number | undefined => priceFor(priceBook, componentId);

  // --- Enchantments ---
  for (const [rawName, rawLevel] of Object.entries(item.enchantments ?? {})) {
    const name = rawName.toUpperCase();
    let level = rawLevel;

    if (id && BLOCKED_ENCHANTMENTS[id]?.includes(name)) continue;
    if (IGNORED_ENCHANTMENTS[name] === level) continue;
    if (STACKING_ENCHANTMENTS.has(name)) level = 1;

    // Silex applies to Efficiency above the base cap.
    if (name === "EFFICIENCY" && level >= 6 && (!id || !IGNORE_SILEX.has(id))) {
      const silexLevels = level - (id === "STONK_PICKAXE" ? 6 : 5);
      const silexUnit = price("SIL_EX");
      if (silexLevels > 0) {
        if (silexUnit !== undefined) {
          const value = silexUnit * silexLevels * APPLICATION_WORTH.silex;
          total += value;
          add(breakdown, "silex", value);
        } else {
          unpriced += 1;
        }
      }
    }

    const bookUnit = price(`ENCHANTMENT_${name}_${level}`);
    if (bookUnit !== undefined) {
      const value = bookUnit * (ENCHANTMENTS_WORTH[name] ?? APPLICATION_WORTH.enchantments);
      total += value;
      add(breakdown, "enchantments", value);
    } else {
      unpriced += 1;
    }
  }

  // --- Hot Potato / Fuming books ---
  const potato = item.hotPotatoCount ?? 0;
  if (potato > 0) {
    const hotCount = Math.min(potato, 10);
    const hotUnit = price("HOT_POTATO_BOOK");
    if (hotUnit !== undefined) {
      const value = hotUnit * hotCount * APPLICATION_WORTH.hotPotatoBook;
      total += value;
      add(breakdown, "hotPotatoBooks", value);
    } else {
      unpriced += 1;
    }

    if (potato > 10) {
      const fumingUnit = price("FUMING_POTATO_BOOK");
      if (fumingUnit !== undefined) {
        const value = fumingUnit * (potato - 10) * APPLICATION_WORTH.fumingPotatoBook;
        total += value;
        add(breakdown, "fumingPotatoBooks", value);
      } else {
        unpriced += 1;
      }
    }
  }

  // --- Recombobulator ---
  const hasEnchantments = Object.keys(item.enchantments ?? {}).length > 0;
  const allowsRecomb =
    (meta?.category && ALLOWED_RECOMBOBULATED_CATEGORIES.has(meta.category.toUpperCase())) || (id ? ALLOWED_RECOMBOBULATED_IDS.has(id) : false);
  if ((item.rarityUpgrades ?? 0) > 0 && (hasEnchantments || allowsRecomb)) {
    const recombUnit = price("RECOMBOBULATOR_3000");
    if (recombUnit !== undefined) {
      const worth = id === "BONE_BOOMERANG" ? APPLICATION_WORTH.recombobulator * 0.5 : APPLICATION_WORTH.recombobulator;
      const value = recombUnit * worth;
      total += value;
      add(breakdown, "recombobulator", value);
    } else {
      unpriced += 1;
    }
  }

  // --- Essence stars + Master stars (from the official upgrade_costs table) ---
  const level = item.dungeonStars ?? 0;
  const upgradeCosts = meta?.upgradeCosts;
  if (level > 0 && upgradeCosts?.length) {
    for (const starCosts of upgradeCosts.slice(0, level)) {
      for (const cost of starCosts) {
        const componentId = cost.essence_type ? `ESSENCE_${cost.essence_type.toUpperCase()}` : cost.item_id;
        const amount = cost.amount ?? 0;
        if (!componentId || amount <= 0) continue;

        const unit = price(componentId);
        if (unit === undefined) {
          unpriced += 1;
          continue;
        }
        const worth = cost.essence_type ? APPLICATION_WORTH.essence : 1;
        const value = unit * amount * worth;
        total += value;
        add(breakdown, "essenceStars", value);
      }
    }

    // Master Stars (6-10) for items whose essence table only covers 1-5.
    if (level > 5 && upgradeCosts.length <= 5) {
      const starsUsed = Math.min(level - 5, 5);
      for (let i = 0; i < starsUsed; i++) {
        const unit = price(MASTER_STARS[i]!);
        if (unit === undefined) {
          unpriced += 1;
          continue;
        }
        const value = unit * APPLICATION_WORTH.masterStar;
        total += value;
        add(breakdown, "masterStars", value);
      }
    }
  }

  // --- Gemstones ---
  for (const [key, rawValue] of Object.entries(item.gems ?? {})) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey === "unlocked_slots" || normalizedKey.endsWith("_gem")) {
      continue;
    }

    const slotType = key.replace(/_\d+$/, "").toUpperCase();
    const type = GENERIC_GEMSTONE_SLOTS.has(slotType) ? gemstoneString(item.gems?.[`${key}_gem`]) : slotType;
    const tier = gemstoneTier(rawValue);
    if (!type || !tier) {
      continue;
    }

    const unit = price(`${tier}_${type}_GEM`);
    if (unit !== undefined) {
      const value = unit * APPLICATION_WORTH.gemstone;
      total += value;
      add(breakdown, "gemstones", value);
    } else {
      unpriced += 1;
    }
  }

  // --- Reforge stones ---
  const category = meta?.category?.toUpperCase();
  const reforge = item.reforge?.toLowerCase();
  if (reforge && category !== "ACCESSORY") {
    const stoneId = REFORGES[reforge];
    if (stoneId) {
      const unit = price(stoneId);
      if (unit !== undefined) {
        const value = unit * APPLICATION_WORTH.reforge;
        total += value;
        add(breakdown, "reforge", value);
      } else {
        unpriced += 1;
      }
    }
  }

  return { total, breakdown, unpriced };
}

function gemstoneTier(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.toUpperCase();
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return gemstoneString((value as { quality?: unknown }).quality);
  }

  return undefined;
}

function gemstoneString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.toUpperCase() : undefined;
}
