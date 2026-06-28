import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupItem } from "../src/item-lookup.js";
import type { HypixelClient } from "../src/hypixelClient.js";

const ITEMS = [
  { id: "HYPERION", name: "Hyperion", tier: "LEGENDARY", category: "SWORD" },
  { id: "ENCHANTED_DIAMOND", name: "Enchanted Diamond", tier: "UNCOMMON", npc_sell_price: 1280 },
  { id: "POWER_WITHER_CHESTPLATE", name: "Necron's Chestplate", tier: "LEGENDARY" },
  { id: "GOLD_NECRON_HEAD", name: "Golden Necron Head", tier: "EPIC" }
];

const BAZAAR = {
  ENCHANTED_DIAMOND: {
    quick_status: {
      buyPrice: 1300,
      sellPrice: 1200,
      buyVolume: 5,
      sellVolume: 7,
      buyMovingWeek: 100,
      sellMovingWeek: 100
    }
  }
};

// Routes the two endpoints lookupItem depends on; no network.
function stubClient(): HypixelClient {
  return {
    hypixel: async (path: string) => {
      if (path.includes("/resources/skyblock/items")) {
        return { data: { items: ITEMS }, meta: {} };
      }
      if (path.includes("/skyblock/bazaar")) {
        return { data: { products: BAZAAR }, meta: {} };
      }
      return { data: {}, meta: {} };
    }
  } as unknown as HypixelClient;
}

function wikiResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

describe("item lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns Bazaar buy/sell/spread for a Bazaar item", async () => {
    const result = await lookupItem(stubClient(), { itemId: "ENCHANTED_DIAMOND" });
    expect(result.found).toBe(true);
    expect((result.item as Record<string, unknown>).npcSellPrice).toBe(1280);
    const value = result.value as Record<string, unknown>;
    expect(value.source).toBe("bazaar");
    expect(value.buyPrice).toBe(1300);
    expect(value.sellPrice).toBe(1200);
    expect(value.spread).toBe(100);
    expect(Array.isArray(result.caveats)).toBe(true);
    expect((result.caveats as unknown[]).length).toBeGreaterThan(0);
    expect(result.freshness).toBeDefined();
    expect(result.priceFreshness).toBeDefined();
  });

  it("flags auction-only items instead of inventing a price", async () => {
    const result = await lookupItem(stubClient(), { itemId: "HYPERION" });
    expect(result.found).toBe(true);
    expect((result.value as Record<string, unknown>).source).toBe("none");
    expect((result.value as Record<string, unknown>).price).toBeUndefined();
  });

  it("returns candidates for an ambiguous search (in-game name -> canonical IDs)", async () => {
    const result = await lookupItem(stubClient(), { search: "necron" });
    expect(result.found).toBe(false);
    const ids = (result.candidates as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain("POWER_WITHER_CHESTPLATE");
    expect(ids).toContain("GOLD_NECRON_HEAD");
  });

  it("resolves a unique item name to a single result", async () => {
    const result = await lookupItem(stubClient(), { search: "Hyperion" });
    expect(result.found).toBe(true);
    expect((result.item as Record<string, unknown>).id).toBe("HYPERION");
  });

  it("can enrich a resolved item with official wiki sections", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain("wiki.hypixel.net/api.php");
      expect(url).toContain("titles=Hyperion");
      return wikiResponse({
        query: {
          pages: [
            {
              pageid: 2423,
              title: "Hyperion",
              fullurl: "https://wiki.hypixel.net/Hyperion",
              revisions: [
                {
                  timestamp: "2025-06-18T00:52:37Z",
                  slots: {
                    main: {
                      content:
                        "{{Item Page\n" +
                        "|item = HYPERION\n" +
                        "|summary = The '''Hyperion''' is a {{Legendary}} [[Dungeon Item|Dungeon]] [[Sword]].\n" +
                        "|obtaining = The '''Hyperion''' can be crafted using 8 {{Item/GIANT_FRAGMENT_LASER}}s and 1 [[Necron's Blade (Unrefined)]]. {{Recipe/HYPERION}}\n" +
                        "|upgrading = The '''Hyperion''' can be upgraded through [[Necron's Blade Scrolls]].\n" +
                        "|usage = The '''Hyperion''' has the following passive ability. <blockquote>Deals + {{color|red|50%}} more damage against Withers.</blockquote>\n" +
                        "|history = {{SkyBlock Version\n|patch = 3543616\n|change1 = '''Hyperion''' Added.\n}}\n" +
                        "}}"
                    }
                  }
                }
              ]
            }
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await lookupItem(stubClient(), { itemId: "HYPERION", includeWiki: true });
    const wiki = result.wiki as Record<string, unknown>;
    const sections = wiki.sections as Record<string, string>;

    expect(wiki.source).toBe("official_hypixel_skyblock_wiki");
    expect(wiki.title).toBe("Hyperion");
    expect(wiki.url).toBe("https://wiki.hypixel.net/Hyperion");
    expect(sections.summary).toContain("Legendary Dungeon Sword");
    expect(sections.obtaining).toContain("GIANT_FRAGMENT_LASER");
    expect(sections.usage).toContain("50% more damage against Withers");
  });

  it("reports found=false for an unknown id", async () => {
    const result = await lookupItem(stubClient(), { itemId: "NOT_A_REAL_ITEM" });
    expect(result.found).toBe(false);
    expect(result.candidates).toBeUndefined();
  });
});
