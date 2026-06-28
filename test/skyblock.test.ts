import { describe, expect, it } from "vitest";
import { classifyInventoryPath, extractInventoryItems, filterNbtDataLocations, findNbtDataLocations } from "../src/nbt.js";
import { summarizeProfile, summarizeMember } from "../src/skyblock.js";
import { dashedUuid, normalizeUuid, stripMinecraftFormatting } from "../src/utils.js";

describe("uuid helpers", () => {
  it("normalizes and formats UUIDs", () => {
    expect(normalizeUuid("12345678-1234-1234-1234-1234567890ab")).toBe("123456781234123412341234567890ab");
    expect(dashedUuid("123456781234123412341234567890ab")).toBe("12345678-1234-1234-1234-1234567890ab");
  });
});

describe("minecraft formatting", () => {
  it("strips color/style codes", () => {
    expect(stripMinecraftFormatting("\u00a76Legendary \u00a7lSword")).toBe("Legendary Sword");
  });
});

describe("profile summaries", () => {
  it("summarizes profile and modern member fields", () => {
    const member = {
      profile: { last_save: 100, first_join: 50 },
      currencies: { coin_purse: 1234 },
      leveling: { experience: 4200 },
      player_data: { experience: { SKILL_MINING: 1000 } },
      pets_data: { pets: [{ type: "ROCK", tier: "LEGENDARY", exp: 200, active: true }] }
    };
    const profile = {
      profile_id: "profile-1",
      cute_name: "Apple",
      selected: true,
      banking: { balance: 5000 },
      members: { abc: member }
    };

    expect(summarizeProfile(profile)).toMatchObject({
      profileId: "profile-1",
      cuteName: "Apple",
      selected: true,
      bank: 5000,
      banking: {
        available: true,
        balance: 5000
      },
      memberCount: 1
    });
    expect(summarizeMember(member, "abc")).toMatchObject({
      uuid: "abc",
      lastSave: 100,
      purse: 1234,
      skyblockLevelXp: 4200,
      skills: { mining: 1000 },
      skillLevels: {
        mining: {
          xp: 1000,
          level: 4
        }
      }
    });
  });

  it("reports banking as unavailable when Hypixel omits profile banking fields", () => {
    expect(
      summarizeProfile({
        profile_id: "profile-1",
        members: {}
      })
    ).toMatchObject({
      banking: {
        available: false
      }
    });
  });

  it("summarizes alternate nested bank balance fields", () => {
    expect(
      summarizeProfile({
        profile_id: "profile-1",
        bank: { balance: 7500 },
        members: {}
      })
    ).toMatchObject({
      bank: 7500,
      banking: {
        available: true,
        balance: 7500
      }
    });
  });
});

describe("inventory item extraction", () => {
  it("creates compact item summaries from simplified NBT", () => {
    const items = extractInventoryItems({
      i: [
        {
          Slot: 0,
          id: "minecraft:diamond_sword",
          Count: 1,
          tag: {
            ExtraAttributes: {
              id: "ASPECT_OF_THE_END",
              modifier: "spicy",
              enchantments: { sharpness: 5 }
            },
            display: {
              Name: "\u00a76Aspect of the End",
              Lore: ["\u00a77Damage: +100", "\u00a76LEGENDARY SWORD"]
            }
          }
        }
      ]
    });

    expect(items[0]).toMatchObject({
      slot: 0,
      skyblockId: "ASPECT_OF_THE_END",
      name: "Aspect of the End",
      rarity: "LEGENDARY",
      reforge: "spicy",
      enchantments: { sharpness: 5 }
    });
  });

  it("can include richer ExtraAttributes details when requested", () => {
    const items = extractInventoryItems(
      {
        i: [
          {
            Slot: 4,
            id: "minecraft:diamond_chestplate",
            Count: 1,
            tag: {
              ExtraAttributes: {
                id: "DIVAN_CHESTPLATE",
                modifier: "jaded",
                uuid: "item-uuid",
                timestamp: "6/17/26 7:00 PM",
                hot_potato_count: 10,
                rarity_upgrades: 1,
                upgrade_level: 5,
                gems: { JADE_0: "PERFECT", AMBER_0: "FINE" },
                drill_fuel: 3000
              },
              display: {
                Name: "\u00a76Chestplate of Divan",
                Lore: ["\u00a76LEGENDARY CHESTPLATE"]
              }
            }
          }
        ]
      },
      { includeItemDetails: true }
    );

    expect(items[0]).toMatchObject({
      slot: 4,
      skyblockId: "DIVAN_CHESTPLATE",
      name: "Chestplate of Divan",
      reforge: "jaded",
      itemUuid: "item-uuid",
      hotPotatoCount: 10,
      rarityUpgrades: 1,
      dungeonStars: 5,
      gems: { JADE_0: "PERFECT", AMBER_0: "FINE" },
      extraAttributes: { drill_fuel: 3000 }
    });
  });
});

describe("inventory section discovery", () => {
  const fakeNbt = "A".repeat(40);

  it("classifies common inventory section paths", () => {
    expect(classifyInventoryPath("inventory.inv_contents")).toBe("inventory");
    expect(classifyInventoryPath("inventory.wardrobe_contents")).toBe("wardrobe");
    expect(classifyInventoryPath("loadout.armor.2.HELMET")).toBe("loadout");
    expect(classifyInventoryPath("inventory.equipment_contents")).toBe("equipment");
    expect(classifyInventoryPath("inventory.ender_chest_contents")).toBe("ender_chest");
    expect(classifyInventoryPath("inventory.backpack_contents.0")).toBe("backpack");
    expect(classifyInventoryPath("inventory.personal_vault_contents")).toBe("personal_vault");
  });

  it("filters sections before callers apply section limits", () => {
    const member = {
      inventory: {
        backpack_contents: Object.fromEntries(
          Array.from({ length: 20 }, (_, index) => [String(index), { data: fakeNbt }])
        ),
        wardrobe_contents: { data: fakeNbt }
      }
    };
    const allLocations = findNbtDataLocations(member);
    const wardrobeLocations = filterNbtDataLocations(allLocations, { sectionTypes: ["wardrobe"] });

    expect(allLocations.filter((location) => location.sectionType === "backpack")).toHaveLength(20);
    expect(wardrobeLocations).toEqual([
      {
        path: "inventory.wardrobe_contents",
        data: fakeNbt,
        sectionType: "wardrobe"
      }
    ]);
    expect(wardrobeLocations.slice(0, 1)).toHaveLength(1);
  });
});
