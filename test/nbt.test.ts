import * as nbt from "prismarine-nbt";
import { gzipSync } from "node:zlib";
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

  it("preserves legacy numeric Minecraft IDs but omits air and empty stacks", () => {
    expect(extractInventoryItems({ i: [
      { id: 4, Count: 64 },
      { id: 0, Count: 0 },
      { id: "minecraft:air", Count: 1 },
      { id: "diamond", Count: 0 },
      { id: "stone", Count: -1 }
    ] })).toEqual([expect.objectContaining({ minecraftId: "4", count: 64 })]);
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
  it("bounds compressed NBT expansion before parsing", async () => {
    const oversized = gzipSync(Buffer.alloc(17 * 1024 * 1024)).toString("base64");
    await expect(decodeBase64Nbt(oversized)).rejects.toThrow(/size|limit|large/i);
  });

  it("rejects nested compression instead of decompressing a second time without a bound", async () => {
    const payload = Buffer.alloc(17 * 1024 * 1024);
    payload[0] = 10; // empty compound, followed by padding
    await expect(decodeBase64Nbt(gzipSync(gzipSync(payload)).toString("base64"))).rejects.toThrow();
  });

  it("rejects oversized encoded data and malformed base64", async () => {
    await expect(decodeBase64Nbt("A".repeat(6 * 1024 * 1024))).rejects.toThrow(/size|limit|large/i);
    await expect(decodeBase64Nbt("%%%invalid%%%")).rejects.toThrow(/base64/i);
  });

  it("decodes gzipped Java NBT", async () => {
    const node = nbt.comp({ i: nbt.list(nbt.comp([{ id: nbt.short(4), Count: nbt.byte(64) }])) });
    const compressed = gzipSync(nbt.writeUncompressed(node as never)).toString("base64");
    expect(extractInventoryItems(await decodeBase64Nbt(compressed))[0]).toMatchObject({ minecraftId: "4", count: 64 });
  });

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

  it("does not report a non-inventory NBT root as an empty inventory", async () => {
    const data = nbt.writeUncompressed(nbt.comp({ unrelated: nbt.int(1) }) as never).toString("base64");
    const decoded = await decodeInventoryData("inventory.inv_contents", data, 60);
    expect(decoded.error).toMatch(/inventory|item list/i);
  });

  it("discovers malformed inventory sections so callers can report failed coverage", () => {
    expect(findNbtDataLocations({ inventory: {
      personal_vault_contents: { data: "corrupt!" },
      inv_contents: { data: "" },
      ender_chest_contents: { data: 42 }
    } }).map((entry) => entry.path)).toEqual([
      "inventory.personal_vault_contents", "inventory.inv_contents", "inventory.ender_chest_contents"
    ]);
  });
});
