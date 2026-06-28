import { describe, expect, it } from "vitest";
import { computeEssenceUpgrade, summarizeEquippedEssenceUpgrades } from "../src/essence-costs.js";
import type { HypixelClient } from "../src/hypixelClient.js";

// Minimal stub that returns a canned Bazaar response so pricing is deterministic
// and offline. Only the `hypixel` method is exercised by buildPriceBook.
function stubClient(prices: Record<string, number>): HypixelClient {
  const products = Object.fromEntries(
    Object.entries(prices).map(([id, buyPrice]) => [id, { quick_status: { buyPrice, sellPrice: buyPrice } }])
  );
  return {
    hypixel: async () => ({ data: { products }, meta: {} })
  } as unknown as HypixelClient;
}

describe("essence upgrade costs", () => {
  it("returns found=false with suggestions for an unrecognized item id", () => {
    const result = computeEssenceUpgrade({ itemId: "WITHER_CHEST" });
    expect(result.found).toBe(false);
    expect(result.suggestions).toContain("POWER_WITHER_CHESTPLATE");
    expect(result.totalEssence).toBeUndefined();
  });

  it("sums per-star essence and coin costs for a known item", () => {
    // CRIMSON_HELMET is Crimson-essence gear that stars to 10 with essence.
    const result = computeEssenceUpgrade({ itemId: "crimson_helmet", fromStar: 0, toStar: 5 });
    expect(result.found).toBe(true);
    expect(result.essenceType).toBe("Crimson");
    expect(result.essenceBazaarId).toBe("ESSENCE_CRIMSON");
    expect(result.maxStar).toBe(10);
    // 1..5 essence amounts sum to a positive total, and per-star covers exactly 5 steps.
    expect(result.totalEssence).toBeGreaterThan(0);
    expect(result.perStar).toHaveLength(5);
    expect(result.totalCoins).toBeGreaterThan(0);
  });

  it("scales totals by quantity", () => {
    const one = computeEssenceUpgrade({ itemId: "CRIMSON_HELMET", fromStar: 0, toStar: 5, quantity: 1 });
    const four = computeEssenceUpgrade({ itemId: "CRIMSON_HELMET", fromStar: 0, toStar: 5, quantity: 4 });
    expect(four.totalEssence).toBe((one.totalEssence ?? 0) * 4);
    expect(four.totalCoins).toBe((one.totalCoins ?? 0) * 4);
  });

  it("clamps toStar to the dataset max and explains the master-star gap", () => {
    // Dungeon weapons only carry essence costs for stars 1-5 in the dataset.
    const result = computeEssenceUpgrade({ itemId: "HYPERION", fromStar: 0, toStar: 10 });
    expect(result.maxStar).toBe(5);
    expect(result.toStar).toBe(5);
    expect(result.requestedToStar).toBe(10);
    expect(result.notes?.[0]).toMatch(/Master Star/i);
  });

  it("returns zero work when from and to are equal", () => {
    const result = computeEssenceUpgrade({ itemId: "CRIMSON_HELMET", fromStar: 5, toStar: 5 });
    expect(result.found).toBe(true);
    expect(result.totalEssence).toBe(0);
    expect(result.perStar).toHaveLength(0);
  });
});

describe("equipped essence upgrade aggregation", () => {
  it("aggregates only upgradeable pieces and skips maxed/unknown gear", async () => {
    const client = stubClient({ ESSENCE_WITHER: 2000 });
    const summary = await summarizeEquippedEssenceUpgrades(client, [
      { skyblockId: "POWER_WITHER_HELMET", dungeonStars: 0 }, // 0 -> 5
      { skyblockId: "POWER_WITHER_LEGGINGS", dungeonStars: 5 }, // already maxed -> skipped
      { skyblockId: "TOTALLY_FAKE_ITEM", dungeonStars: 0 } // unknown -> skipped
    ]);

    expect(summary).toBeDefined();
    expect(Object.keys(summary!.essenceByType as object)).toEqual(["Wither"]);
    // Only the helmet contributes; its essence is priced at 2000/each.
    const perPiece = summary!.perPiece as Array<Record<string, unknown>>;
    expect(perPiece).toHaveLength(1);
    expect(perPiece[0]!.skyblockId).toBe("POWER_WITHER_HELMET");
    // Total = essence priced at 2000 each + exact upgrade coin costs (stars 4-5).
    const helmetEssence = perPiece[0]!.essence as number;
    const upgradeCoins = (summary!.upgradeCoins as number) ?? 0;
    expect(summary!.estimatedTotalCoins).toBe(helmetEssence * 2000 + upgradeCoins);
    expect(upgradeCoins).toBeGreaterThan(0);
  });

  it("returns undefined when no pieces are upgradeable", async () => {
    const client = stubClient({ ESSENCE_WITHER: 2000 });
    const summary = await summarizeEquippedEssenceUpgrades(client, [
      { skyblockId: "POWER_WITHER_LEGGINGS", dungeonStars: 5 }
    ]);
    expect(summary).toBeUndefined();
  });
});
