import * as nbt from "prismarine-nbt";
import { describe, expect, it } from "vitest";
import { getSkyblockNetworth } from "../src/networth.js";
import type { HypixelClient } from "../src/hypixelClient.js";
import type { JsonObject } from "../src/types.js";

const PROFILE_ID = "b".repeat(32);
const MEMBER_UUID = "a".repeat(32);

function inventory(items: { id: string; uuid?: string; count?: number; enchants?: Record<string, number> }[]): { data: string } {
  return { data: nbt.writeUncompressed(nbt.comp({ i: nbt.list(nbt.comp(items.map((item) => ({
    id: nbt.string("stone"), Count: nbt.byte(item.count ?? 1), tag: nbt.comp({ ExtraAttributes: nbt.comp({
      id: nbt.string(item.id),
      ...(item.uuid ? { uuid: nbt.string(item.uuid) } : {}),
      ...(item.enchants ? { enchantments: nbt.comp(Object.fromEntries(Object.entries(item.enchants).map(([id, level]) => [id, nbt.int(level)]))) } : {})
    }) })
  })))) }) as never).toString("base64") };
}

function client(member: JsonObject, prices: Record<string, number> = {}): HypixelClient {
  return {
    hasApiKey: () => true,
    hypixel: async (path: string) => ({
      data: path.endsWith("/profile")
        ? { profile: { profile_id: PROFILE_ID, members: { [MEMBER_UUID]: member } } }
        : path.endsWith("/bazaar")
          ? { products: Object.fromEntries(Object.entries(prices).map(([id, price]) => [id, { quick_status: { buyPrice: price, sellPrice: price } }])) }
          : { items: [] },
      meta: { cached: false, fetchedAt: new Date().toISOString(), source: "fixture" }
    })
  } as unknown as HypixelClient;
}

async function networth(member: JsonObject, prices: Record<string, number> = {}): Promise<JsonObject> {
  return (await getSkyblockNetworth(client(member, prices), { profileId: PROFILE_ID, includeUnpriced: true })).networth as JsonObject;
}

describe("networth coverage and holdings", () => {
  it("counts duplicated UUID holdings once but retains distinct items of the same ID", async () => {
    const result = await networth({ inventory: {
      inv_contents: inventory([{ id: "DIAMOND", uuid: "physical-a" }, { id: "DIAMOND", uuid: "physical-b" }]),
      wardrobe_contents: inventory([{ id: "DIAMOND", uuid: "physical-a" }])
    } }, { DIAMOND: 100 });
    expect(result.total).toBe(200);
    expect(result.coverage).toMatchObject({ totalItemStacks: 2, duplicateItemStacks: 1 });
  });

  it("flags failed NBT sections instead of reporting a complete empty inventory", async () => {
    const result = await networth({ currencies: { coin_purse: 1000 }, inventory: {
      inv_contents: { data: "e".repeat(40) }
    } });
    expect(result.total).toBe(1000);
    expect(result.coverage).toMatchObject({ complete: false, failedSections: 1 });
    expect((result.coverage as JsonObject).sectionErrors).toEqual(expect.arrayContaining([expect.objectContaining({ path: "inventory.inv_contents" })]));
  });

  it("reports missing inventory API data and entirely unpriced sacks", async () => {
    const result = await networth({ inventory: { sacks_counts: { UNKNOWN_ITEM: 10 } } });
    expect(result.coverage).toMatchObject({ complete: false, inventoryAvailable: false });
    expect(result.sacks).toMatchObject({ total: 0, totalKinds: 1, pricedKinds: 0, unpricedKinds: 1 });
    expect((result.sacks as JsonObject).unpricedItems).toEqual([{ skyblockId: "UNKNOWN_ITEM", count: 10 }]);
  });

  it("prices standalone enchanted books by their Bazaar product without application discount", async () => {
    const result = await networth({ inventory: { inv_contents: inventory([{ id: "ENCHANTED_BOOK", enchants: { sharpness: 6 }, count: 2 }]) } }, {
      ENCHANTMENT_SHARPNESS_6: 1_000_000
    });
    expect(result.total).toBe(2_000_000);
    expect(result.coverage).toMatchObject({ pricedItemStacks: 1, unpricedItemStacks: 0 });
    expect((result.items as JsonObject).modifiers).toMatchObject({ total: 0 });
  });

  it("does not silently ignore item truncation", async () => {
    const result = await networth({ inventory: { inv_contents: inventory(Array.from({ length: 501 }, () => ({ id: "DIAMOND" }))) } }, { DIAMOND: 100 });
    const coverage = result.coverage as JsonObject;
    // Either decode all items or disclose the omitted stack.
    expect(result.total === 50_100 || (coverage.complete === false && Number(coverage.truncatedSections) > 0)).toBe(true);
  });
});
