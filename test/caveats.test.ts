import { describe, expect, it } from "vitest";
import { getBazaar } from "../src/skyblock.js";
import type { HypixelClient } from "../src/hypixelClient.js";
import { AUCTION_CAVEATS, BAZAAR_CAVEATS, ITEM_VALUE_CAVEATS, NETWORTH_CAVEATS } from "../src/caveats.js";

function bazaarClient(): HypixelClient {
  return {
    hypixel: async () => ({
      data: {
        products: {
          ENCHANTED_DIAMOND: {
            quick_status: { buyPrice: 1300, sellPrice: 1200, buyVolume: 5, sellVolume: 7, buyMovingWeek: 100, sellMovingWeek: 100 }
          }
        }
      },
      meta: { cached: false, fetchedAt: new Date().toISOString(), source: "test" }
    })
  } as unknown as HypixelClient;
}

describe("caveats constants", () => {
  it("are all non-empty arrays of strings", () => {
    for (const list of [BAZAAR_CAVEATS, AUCTION_CAVEATS, ITEM_VALUE_CAVEATS, NETWORTH_CAVEATS]) {
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(0);
      expect(list.every((entry) => typeof entry === "string" && entry.length > 0)).toBe(true);
    }
  });
});

describe("getBazaar output guardrails", () => {
  it("attaches freshness and caveats to non-raw output", async () => {
    const result = await getBazaar(bazaarClient(), {});
    expect(result.caveats).toBe(BAZAAR_CAVEATS);
    const freshness = result.freshness as Record<string, unknown>;
    expect(freshness).toBeDefined();
    expect(typeof freshness.dataAgeSeconds).toBe("number");
    expect(freshness.staleWarning).toBeUndefined();
  });
});
