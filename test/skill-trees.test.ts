import { describe, expect, it } from "vitest";
import {
  countUnplacedNucleusCrystals,
  extractTreePerks,
  formatPerkName,
  isNucleusCrystal,
  summarizeHotfTree,
  summarizeHotmTree
} from "../src/skill-trees.js";

describe("skill trees", () => {
  it("formats perk names and extracts unlocked nodes", () => {
    expect(formatPerkName("mining_fortune", "mining")).toBe("Mining Fortune");
    expect(formatPerkName("axe_toss", "foraging")).toBe("Axe Toss");

    const perks = extractTreePerks(
      {
        toggle_mole: 1,
        mole: 5,
        mining_fortune: 50,
        core_of_the_mountain: 7
      },
      "mining"
    );

    expect(perks).toEqual(
      expect.arrayContaining([
        { id: "mole", name: "Mole", level: 5 },
        { id: "mining_fortune", name: "Mining Fortune", level: 50 },
        { id: "core_of_the_mountain", name: "Core of the Mountain", level: 7 }
      ])
    );
    expect(perks.find((perk) => perk.id.startsWith("toggle_"))).toBeUndefined();
  });

  it("summarizes HOTM and HOTF trees", () => {
    const skillTree = {
      nodes: {
        mining: { core_of_the_mountain: 7, mole: 1 },
        foraging: { axe_toss: 1, foraging_fortune: 20 }
      },
      selected_ability: {
        mining: "pickobulus",
        foraging: "axe_toss"
      }
    };

    expect(summarizeHotmTree(skillTree, { powder_mithril: 1000 })).toMatchObject({
      level: 7,
      selectedAbility: "pickobulus",
      unlockedPerks: 2,
      powder: { mithril: 1000 }
    });

    expect(summarizeHotfTree(skillTree, { forests_whispers: 500, forests_whispers_spent: 10000 })).toMatchObject({
      selectedAbility: "axe_toss",
      unlockedPerks: 2,
      whispers: { current: 500, spent: 10000 }
    });
  });

  it("only counts unplaced nucleus crystals, not forge-only crystals", () => {
    const crystals = {
      jade_crystal: { state: "FOUND", total_found: 1, total_placed: 0 },
      ruby_crystal: { state: "FOUND", total_found: 1, total_placed: 0 },
      jasper_crystal: { state: "FOUND", total_found: 1, total_placed: 0 },
      topaz_crystal: { state: "PLACED", total_found: 2, total_placed: 1 }
    };

    expect(countUnplacedNucleusCrystals(crystals)).toBe(1);
  });

  it("title-cases unknown perk ids and strips toggle_ prefixes", () => {
    expect(formatPerkName("toggle_some_new_perk")).toBe("Some New Perk");
    expect(formatPerkName("unmapped_node", "foraging")).toBe("Unmapped Node");
  });

  it("guards empty/undefined inputs", () => {
    expect(extractTreePerks(undefined, "mining")).toEqual([]);
    expect(countUnplacedNucleusCrystals(undefined)).toBe(0);
    expect(summarizeHotmTree(undefined, undefined)).toBeUndefined();
    expect(summarizeHotfTree(undefined, undefined)).toBeUndefined();
    expect(isNucleusCrystal("JADE_CRYSTAL")).toBe(true);
    expect(isNucleusCrystal("ruby_crystal")).toBe(false);
  });

  it("summarizes crystal states inside the HOTM tree", () => {
    const skillTree = { nodes: { mining: { core_of_the_mountain: 9 } }, tokens_spent: 22 };
    const miningCore = {
      powder_mithril: 100,
      powder_gemstone_total: 5000,
      crystals: {
        jade_crystal: { state: "FOUND", total_found: 3, total_placed: 1 },
        amber_crystal: "broken"
      },
      biomes: { dwarven: 1 }
    };

    const hotm = summarizeHotmTree(skillTree, miningCore) as {
      tokensSpent: number;
      crystals: Record<string, unknown>;
    };
    expect(hotm.tokensSpent).toBe(22);
    expect(hotm.crystals).toMatchObject({ jade_crystal: { state: "FOUND", totalFound: 3, totalPlaced: 1 } });
    // Non-record crystal entries are skipped.
    expect(hotm.crystals.amber_crystal).toBeUndefined();
  });
});
