import { describe, expect, it } from "vitest";
import { aggregateStorageSections, extractSacksCounts } from "../src/storage.js";
import type { DecodedInventory } from "../src/types.js";

describe("storage aggregation", () => {
  it("merges duplicate items across sections and summarizes sacks", () => {
    const decoded: DecodedInventory[] = [
      {
        path: "inventory.inv_contents",
        sectionType: "inventory",
        itemCount: 1,
        shownItems: 1,
        items: [{ slot: 0, skyblockId: "DIAMOND", name: "Diamond", count: 32 }],
        truncated: false
      },
      {
        path: "inventory.ender_chest_contents",
        sectionType: "ender_chest",
        itemCount: 1,
        shownItems: 1,
        items: [{ slot: 1, skyblockId: "DIAMOND", name: "Diamond", count: 10 }],
        truncated: false
      }
    ];

    const result = aggregateStorageSections(decoded, { MITHRIL_ORE: 5000, COAL: 0 }, {
      groupBySkyblockId: true,
      limit: 10
    });

    expect(result.uniqueItems).toBe(1);
    expect(result.items).toEqual([
      expect.objectContaining({
        skyblockId: "DIAMOND",
        count: 42,
        locations: expect.arrayContaining([
          expect.objectContaining({ sectionType: "inventory" }),
          expect.objectContaining({ sectionType: "ender_chest" })
        ])
      })
    ]);
    expect(result.sacks).toMatchObject({
      kinds: 1,
      totalItems: 5000,
      top: { MITHRIL_ORE: 5000 }
    });
  });

  it("filters by search and skyblock IDs", () => {
    const decoded: DecodedInventory[] = [
      {
        path: "inventory.backpack_contents.0",
        sectionType: "backpack",
        itemCount: 2,
        shownItems: 2,
        items: [
          { slot: 0, skyblockId: "ENCHANTED_DIAMOND", name: "Enchanted Diamond", count: 1 },
          { slot: 1, skyblockId: "COAL", name: "Coal", count: 64 }
        ],
        truncated: false
      }
    ];

    const searchResult = aggregateStorageSections(decoded, undefined, { search: "enchanted" });
    expect(searchResult.uniqueItems).toBe(1);
    expect(searchResult.items?.[0]).toMatchObject({ skyblockId: "ENCHANTED_DIAMOND" });

    const idResult = aggregateStorageSections(decoded, undefined, { skyblockIds: ["COAL"] });
    expect(idResult.uniqueItems).toBe(1);
    expect(idResult.items?.[0]).toMatchObject({ skyblockId: "COAL" });
  });

  it("restricts scanning to requested section types", () => {
    const decoded: DecodedInventory[] = [
      {
        path: "inventory.inv_contents",
        sectionType: "inventory",
        itemCount: 1,
        shownItems: 1,
        items: [{ slot: 0, skyblockId: "DIAMOND", name: "Diamond", count: 1 }],
        truncated: false
      },
      {
        path: "inventory.ender_chest_contents",
        sectionType: "ender_chest",
        itemCount: 1,
        shownItems: 1,
        items: [{ slot: 0, skyblockId: "EMERALD", name: "Emerald", count: 1 }],
        truncated: false
      }
    ];

    const result = aggregateStorageSections(decoded, undefined, { sectionTypes: ["ender_chest"] });
    expect(result.sectionsScanned).toBe(2);
    expect(result.sectionCounts).toEqual({ ender_chest: 1 });
    expect(result.uniqueItems).toBe(1);
    expect(result.items?.[0]).toMatchObject({ skyblockId: "EMERALD" });
  });

  it("keeps per-slot entries and truncates when grouping is disabled", () => {
    const items = Array.from({ length: 10 }, (_, slot) => ({
      slot,
      skyblockId: "DIAMOND",
      name: "Diamond",
      count: 1
    }));
    const decoded: DecodedInventory[] = [
      { path: "p", sectionType: "backpack", itemCount: 10, shownItems: 10, items, truncated: false }
    ];

    const result = aggregateStorageSections(decoded, undefined, { groupBySkyblockId: false, limit: 5 });
    expect(result.uniqueItems).toBe(10);
    expect(result.items).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it("caps tracked locations per grouped item at 8", () => {
    const items = Array.from({ length: 12 }, (_, slot) => ({
      slot,
      skyblockId: "DIAMOND",
      name: "Diamond",
      count: 1
    }));
    const decoded: DecodedInventory[] = [
      { path: "p", sectionType: "backpack", itemCount: 12, shownItems: 12, items, truncated: false }
    ];

    const result = aggregateStorageSections(decoded, undefined, {});
    expect(result.uniqueItems).toBe(1);
    expect((result.items as Array<{ locations: unknown[] }>)[0].locations).toHaveLength(8);
  });

  it("omits the sacks summary when there are no positive counts", () => {
    expect(aggregateStorageSections([], { COAL: 0 }, {}).sacks).toBeUndefined();
    expect(aggregateStorageSections([], undefined, {}).sacks).toBeUndefined();
  });
});

describe("extractSacksCounts", () => {
  it("reads sacks_counts from the member inventory or returns undefined", () => {
    expect(extractSacksCounts({ inventory: { sacks_counts: { COAL: 10 } } })).toEqual({ COAL: 10 });
    expect(extractSacksCounts({})).toBeUndefined();
    expect(extractSacksCounts(undefined)).toBeUndefined();
  });
});
