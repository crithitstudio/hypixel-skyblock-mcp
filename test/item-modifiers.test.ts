import { describe, expect, it } from "vitest";
import { valueItemModifiers } from "../src/item-modifiers.js";
import type { ItemMeta } from "../src/item-modifiers.js";
import type { PriceBook } from "../src/pricing.js";
import type { DecodedInventoryItem } from "../src/types.js";

function book(prices: Record<string, number>): PriceBook {
  return {
    prices: new Map(Object.entries(prices).map(([id, value]) => [id.toUpperCase(), value])),
    basis: "buy",
    sources: ["bazaar"]
  };
}

describe("item modifier valuation", () => {
  it("prices enchantments with per-enchant worth overrides and ignores SCAVENGER 5", () => {
    const item: DecodedInventoryItem = {
      skyblockId: "HYPERION",
      enchantments: { sharpness: 6, ultimate_soul_eater: 5, scavenger: 5 }
    };
    const prices = book({
      ENCHANTMENT_SHARPNESS_6: 1000, // x0.85 = 850
      ENCHANTMENT_ULTIMATE_SOUL_EATER_5: 2000, // x0.35 = 700
      ENCHANTMENT_SCAVENGER_5: 9999 // ignored entirely
    });

    const result = valueItemModifiers(item, prices, undefined);
    expect(result.breakdown.enchantments).toBe(850 + 700);
    expect(result.total).toBe(1550);
  });

  it("adds Silex value for Efficiency above level 5", () => {
    const item: DecodedInventoryItem = { skyblockId: "DIAMOND_PICKAXE", enchantments: { efficiency: 7 } };
    const prices = book({ ENCHANTMENT_EFFICIENCY_7: 0, SIL_EX: 100 }); // 2 levels x 100 x 0.75 = 150
    const result = valueItemModifiers(item, prices, undefined);
    expect(result.breakdown.silex).toBe(150);
  });

  it("values hot potato (<=10) at full price and fuming books at 60%", () => {
    const item: DecodedInventoryItem = { skyblockId: "SOME_SWORD", hotPotatoCount: 12 };
    const prices = book({ HOT_POTATO_BOOK: 50, FUMING_POTATO_BOOK: 200 });
    const result = valueItemModifiers(item, prices, undefined);
    expect(result.breakdown.hotPotatoBooks).toBe(10 * 50 * 1);
    expect(result.breakdown.fumingPotatoBooks).toBe(2 * 200 * 0.6);
  });

  it("credits recombobulator only when enchanted or an allowed category", () => {
    const prices = book({ RECOMBOBULATOR_3000: 1_000_000 });
    const sword: DecodedInventoryItem = { skyblockId: "X_SWORD", rarityUpgrades: 1, enchantments: { sharpness: 1 } };
    expect(valueItemModifiers(sword, prices, undefined).breakdown.recombobulator).toBe(800_000);

    // A bare item with no enchants and a non-allowed category gets no recomb credit.
    const bare: DecodedInventoryItem = { skyblockId: "X_PICKAXE", rarityUpgrades: 1 };
    expect(valueItemModifiers(bare, prices, { category: "PICKAXE" }).breakdown.recombobulator).toBeUndefined();

    // An accessory (allowed category) without enchants does get credit.
    const acc: DecodedInventoryItem = { skyblockId: "X_TALISMAN", rarityUpgrades: 1 };
    expect(valueItemModifiers(acc, prices, { category: "ACCESSORY" }).breakdown.recombobulator).toBe(800_000);
  });

  it("values essence stars (x0.75) and master stars from the upgrade_costs table", () => {
    const meta: ItemMeta = {
      category: "SWORD",
      upgradeCosts: Array.from({ length: 5 }, () => [{ type: "ESSENCE", essence_type: "WITHER", amount: 10 }])
    };
    const item: DecodedInventoryItem = { skyblockId: "HYPERION", dungeonStars: 7 };
    const prices = book({ ESSENCE_WITHER: 2, FIRST_MASTER_STAR: 100, SECOND_MASTER_STAR: 100 });

    const result = valueItemModifiers(item, prices, meta);
    // 5 essence stars x 10 x 2 x 0.75 = 75; 2 master stars x 100 x 1 = 200.
    expect(result.breakdown.essenceStars).toBe(75);
    expect(result.breakdown.masterStars).toBe(200);
  });

  it("values direct-slot gemstones at full Bazaar price", () => {
    const item: DecodedInventoryItem = { skyblockId: "DIVAN_CHESTPLATE", gems: { RUBY_0: "PERFECT" } };
    const result = valueItemModifiers(item, book({ PERFECT_RUBY_GEM: 1_000_000 }), { category: "CHESTPLATE" });

    expect(result.breakdown.gemstones).toBe(1_000_000);
    expect(result.total).toBe(1_000_000);
  });

  it("values generic-slot gemstones using the sibling gem type", () => {
    const item: DecodedInventoryItem = {
      skyblockId: "TERMINATOR",
      gems: { COMBAT_0: { quality: "PERFECT" }, COMBAT_0_gem: "JASPER" }
    };
    const result = valueItemModifiers(item, book({ PERFECT_JASPER_GEM: 2_000_000 }), { category: "BOW" });

    expect(result.breakdown.gemstones).toBe(2_000_000);
    expect(result.total).toBe(2_000_000);
  });

  it("skips gemstone metadata keys and counts unpriced gemstone components", () => {
    const item: DecodedInventoryItem = {
      skyblockId: "DIVAN_LEGGINGS",
      gems: {
        unlocked_slots: ["JADE_0"],
        JADE_0_gem: "AMBER",
        JADE_0: "FINE",
        AMBER_0: "PERFECT"
      }
    };
    const result = valueItemModifiers(item, book({ FINE_JADE_GEM: 100 }), { category: "LEGGINGS" });

    expect(result.breakdown.gemstones).toBe(100);
    expect(result.total).toBe(100);
    expect(result.unpriced).toBe(1);
  });

  it("values reforge stones, ignores basic reforges, and skips accessory reforges", () => {
    const prices = book({ MIDAS_JEWEL: 5_000_000 });
    const gilded: DecodedInventoryItem = { skyblockId: "MIDAS_SWORD", reforge: "gilded" };
    expect(valueItemModifiers(gilded, prices, { category: "SWORD" }).breakdown.reforge).toBe(5_000_000);
    expect(valueItemModifiers(gilded, book({}), { category: "SWORD" }).unpriced).toBe(1);

    const basic: DecodedInventoryItem = { skyblockId: "ASPECT_OF_THE_END", reforge: "sharp" };
    const basicResult = valueItemModifiers(basic, prices, { category: "SWORD" });
    expect(basicResult.breakdown.reforge).toBeUndefined();
    expect(basicResult.unpriced).toBe(0);

    const accessory: DecodedInventoryItem = { skyblockId: "SOME_TALISMAN", reforge: "gilded" };
    expect(valueItemModifiers(accessory, prices, { category: "ACCESSORY" }).breakdown.reforge).toBeUndefined();
  });

  it("counts unpriced components instead of assuming them free", () => {
    const item: DecodedInventoryItem = { skyblockId: "HYPERION", enchantments: { sharpness: 6 }, hotPotatoCount: 5 };
    const result = valueItemModifiers(item, book({}), undefined);
    expect(result.total).toBe(0);
    expect(result.unpriced).toBe(2); // sharpness book + hot potato book
  });
});
