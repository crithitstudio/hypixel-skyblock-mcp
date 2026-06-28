import * as nbt from "prismarine-nbt";
import { describe, expect, it } from "vitest";
import {
  classifyInventoryPath,
  decodeBase64Nbt,
  decodeInventoryData,
  extractInventoryItems,
  filterNbtDataLocations,
  findNbtDataLocations
} from "../src/nbt.js";

describe("classifyInventoryPath", () => {
  it("maps known path fragments to section types", () => {
    expect(classifyInventoryPath("foo.loadout.bar")).toBe("loadout");
    expect(classifyInventoryPath("wardrobe_contents")).toBe("wardrobe");
    expect(classifyInventoryPath("equipment_contents")).toBe("equipment");
    expect(classifyInventoryPath("inv_armor")).toBe("armor");
    expect(classifyInventoryPath("ender_chest_contents")).toBe("ender_chest");
    expect(classifyInventoryPath("personal_vault_contents")).toBe("personal_vault");
    expect(classifyInventoryPath("talisman_bag")).toBe("accessory_bag");
    expect(classifyInventoryPath("potion_bag")).toBe("potion_bag");
    expect(classifyInventoryPath("fishing_bag")).toBe("fishing_bag");
    expect(classifyInventoryPath("quiver")).toBe("quiver");
    expect(classifyInventoryPath("backpack_contents.0")).toBe("backpack");
    expect(classifyInventoryPath("sacks_counts")).toBe("sack");
    expect(classifyInventoryPath("inv_contents")).toBe("inventory");
    expect(classifyInventoryPath("something_bag")).toBe("container");
    expect(classifyInventoryPath("totally_unknown")).toBe("unknown");
  });
});

describe("extractInventoryItems", () => {
  it("summarizes a rich item with enchantments, rarity, modifiers and extra details", () => {
    const simplified = {
      i: [
        {
          id: "diamond_sword",
          Count: 1,
          Slot: 4,
          tag: {
            display: {
              Name: "§5Aspect of the End",
              Lore: ["§7Teleports you", "§5EPIC SWORD"]
            },
            ExtraAttributes: {
              id: "ASPECT_OF_THE_END",
              modifier: "sharp",
              enchantments: { sharpness: 5, broken: "nope" },
              attributes: { mending: 3 },
              gems: { JADE_0: "FINE" },
              hot_potato_count: 7,
              rarity_upgrades: 1,
              upgrade_level: 5,
              dungeon_item_level: 3,
              uuid: "abc-123",
              timestamp: "ts",
              custom_data: { nested: [1, 2, "x"], deep: { keep: true } }
            }
          }
        },
        // No identifying fields -> dropped.
        {},
        // Non-record entry -> dropped.
        42
      ]
    };

    const items = extractInventoryItems(simplified, { includeItemDetails: true, maxLoreLines: 1 });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({
      slot: 4,
      skyblockId: "ASPECT_OF_THE_END",
      minecraftId: "diamond_sword",
      name: "Aspect of the End",
      rarity: "EPIC",
      reforge: "sharp",
      hotPotatoCount: 7,
      rarityUpgrades: 1,
      dungeonStars: 5
    });
    // Non-numeric enchantments are stripped.
    expect(item.enchantments).toEqual({ sharpness: 5 });
    // Lore is clamped to maxLoreLines.
    expect(item.lore).toHaveLength(1);
    // ExtraAttributes summary keeps non-omitted keys (including nested structures).
    expect(item.extraAttributes).toMatchObject({ custom_data: { nested: [1, 2, "x"], deep: { keep: true } } });
  });

  it("returns [] when there is no item array", () => {
    expect(extractInventoryItems({ nope: true })).toEqual([]);
  });
});

describe("findNbtDataLocations + filter", () => {
  const blob = "A".repeat(40); // looks like base64 NBT (>32 chars, base64 charset)

  it("finds inventory-like data blobs and dedupes by path", () => {
    const member = {
      inventory: {
        inv_contents: { data: blob },
        ender_chest_contents: { data: blob }
      },
      // Non-inventory path: excluded unless includeAllNbtData is set.
      profile_banner: { data: blob }
    };

    const found = findNbtDataLocations(member);
    const paths = found.map((l) => l.path);
    expect(paths).toContain("inventory.inv_contents");
    expect(paths).toContain("inventory.ender_chest_contents");
    expect(paths).not.toContain("profile_banner");

    const all = findNbtDataLocations(member, [], { includeAllNbtData: true });
    expect(all.map((l) => l.path)).toContain("profile_banner");

    expect(findNbtDataLocations("not-a-record")).toEqual([]);
  });

  it("filters by section type and path, treating 'all' as no filter", () => {
    const member = {
      inventory: {
        inv_contents: { data: blob },
        ender_chest_contents: { data: blob }
      }
    };
    const locations = findNbtDataLocations(member);

    expect(filterNbtDataLocations(locations, { sectionTypes: ["ender_chest"] })).toHaveLength(1);
    expect(filterNbtDataLocations(locations, { sectionPaths: ["inv_contents"] })).toHaveLength(1);
    expect(filterNbtDataLocations(locations, { sectionTypes: ["all"] })).toHaveLength(2);
  });
});

describe("decode round-trip + error handling", () => {
  it("decodes a real base64 NBT payload into items", async () => {
    const node = nbt.comp({
      i: nbt.list(
        nbt.comp([
          {
            id: nbt.string("diamond"),
            Count: nbt.byte(3),
            tag: nbt.comp({
              ExtraAttributes: nbt.comp({ id: nbt.string("ENCHANTED_DIAMOND") })
            })
          }
        ])
      )
    });
    const base64 = nbt.writeUncompressed(node as never).toString("base64");

    const simplified = (await decodeBase64Nbt(base64)) as { i: unknown[] };
    expect(Array.isArray(simplified.i)).toBe(true);

    const decoded = await decodeInventoryData("inventory.inv_contents", base64, 60);
    expect(decoded.sectionType).toBe("inventory");
    expect(decoded.itemCount).toBe(1);
    expect(decoded.items[0]).toMatchObject({ skyblockId: "ENCHANTED_DIAMOND", count: 3 });
  });

  it("returns an error result for malformed payloads instead of throwing", async () => {
    const decoded = await decodeInventoryData("inventory.inv_contents", "!!!not-base64!!!", 60);
    expect(decoded.itemCount).toBe(0);
    expect(decoded.items).toEqual([]);
    expect(decoded.error).toBeTruthy();
  });
});
