import { describe, expect, it } from "vitest";
import { summarizeEssence, summarizeMuseumMember, summarizeProgression } from "../src/progression.js";

describe("progression summaries", () => {
  it("includes HOTM/HOTF trees and structured essence", () => {
    const member = {
      leveling: { experience: 17907, highest_pet_score: 99 },
      mining_core: { experience: 347_000, powder_mithril: 100, powder_gemstone: 50 },
      foraging_core: { forests_whispers: 10, forests_whispers_spent: 5000 },
      skill_tree: {
        nodes: {
          mining: { core_of_the_mountain: 7, mole: 1 },
          foraging: { axe_toss: 1 }
        },
        selected_ability: { mining: "pickobulus", foraging: "axe_toss" }
      },
      currencies: {
        essence: {
          WITHER: { current: 140 },
          CRIMSON: { current: 20 }
        }
      },
      nether_island_player_data: {
        selected_faction: "mages",
        kuudra_completed_tiers: { none: 5, hot: 3 }
      },
      rift: { lifetime_motes: 1000, visited_zones: ["wizard", "castle"] }
    };

    const progression = summarizeProgression(member);

    expect(progression.hotm).toMatchObject({
      level: 7,
      selectedAbility: "pickobulus"
    });
    expect(progression.hotf).toMatchObject({
      selectedAbility: "axe_toss",
      whispers: { current: 10, spent: 5000 }
    });
    expect(progression.crimsonIsle).toMatchObject({
      selectedFaction: "mages",
      kuudraTiersUnlocked: 2,
      kuudraRunsCompleted: 8
    });
    expect(progression.rift).toMatchObject({
      lifetimeMotes: 1000,
      visitedZones: 2
    });
    expect(summarizeEssence(member)).toMatchObject({
      WITHER: { current: 140 },
      CRIMSON: { current: 20 }
    });
  });

  it("summarizes fairy souls, garden, minions, bestiary and milestones from a full member", () => {
    const member = {
      leveling: {
        experience: 10_093,
        highest_pet_score: 150,
        completions: { NUCLEUS_RUNS: 12 },
        completed_tasks: ["a", "b", "c"]
      },
      fairy_soul: { total_collected: 200, fairy_exchanges: 40, unspent_souls: 5 },
      garden_experience: 10_120,
      garden_player_data: { copper: 9000, discovered_greenhouse_crops: ["WHEAT", "CARROT"] },
      player_data: {
        generators: { COBBLESTONE_1: 1, COAL_1: 1 },
        unlocked_generators: ["COBBLESTONE_1", "COAL_1", "IRON_1"]
      },
      bestiary: {
        kills: { zombie: 100, skeleton: 50, ignored: "x" },
        milestone_claimed: ["m1", "m2"]
      },
      slayer: {
        slayer_bosses: {
          zombie: { xp: 1_000_000, claimed_levels: { level_7: true, level_8: false } }
        }
      }
    };

    const progression = summarizeProgression(member);

    expect(progression.skyblockLevel).toMatchObject({ level: 100 });
    expect(progression.fairySouls).toMatchObject({ collected: 200, unspent: 5, totalAvailable: 273 });
    expect(progression.garden).toMatchObject({ level: { level: 10 }, copper: 9000 });
    expect(progression.minions).toMatchObject({ craftedVariants: 2, unlockedTypes: 3 });
    expect(progression.bestiary).toMatchObject({ trackedMobs: 2, totalKills: 150, milestonesClaimed: 2 });
    expect(progression.milestones).toMatchObject({ nucleusRuns: 12, highestPetScore: 150, completedTaskCount: 3 });
    expect(progression.slayerTiers).toMatchObject({ zombie: { tier: 7, xp: 1_000_000 } });
  });

  it("returns undefined sections when source data is absent", () => {
    const progression = summarizeProgression({});
    expect(progression.fairySouls).toBeUndefined();
    expect(progression.minions).toBeUndefined();
    expect(progression.bestiary).toBeUndefined();
    expect(progression.crimsonIsle).toBeUndefined();
    expect(progression.rift).toBeUndefined();
    expect(summarizeEssence({})).toBeUndefined();
  });

  it("reads essence and museum data from their alternate shapes", () => {
    // Flat essence values (no { current } wrapper).
    expect(summarizeEssence({ essence: { WITHER: 99 } })).toMatchObject({ WITHER: { current: 99 } });

    const museum = {
      data: {
        members: {
          "uuid-1": {
            value: 5000,
            items: [{ type: "weapons" }, { type: "armor" }, { type: "weapons" }, {}]
          }
        }
      }
    };
    expect(summarizeMuseumMember(museum, "uuid-1")).toMatchObject({
      value: 5000,
      itemCount: 4,
      uniqueTypes: 2
    });
    expect(summarizeMuseumMember(museum, "missing")).toBeUndefined();
    expect(summarizeMuseumMember(undefined, "uuid-1")).toBeUndefined();
  });

  it("counts museum item maps without pretending that absent item data is empty", () => {
    expect(summarizeMuseumMember({ data: { members: { abc: { items: { HYPERION: { donated_time: 1 }, DIVAN_HELMET: { donated_time: 2 } }, special: [{ donated_time: 3 }] } } } }, "abc")).toMatchObject({ itemCount: 2, specialItemCount: 1 });
    expect(summarizeMuseumMember({ data: { members: { abc: { value: 99 } } } }, "abc")?.itemCount).toBeUndefined();
  });

  it("reads actual Crimson Isle reputation fields", () => {
    expect(summarizeProgression({ nether_island_player_data: { mages_reputation: 100, barbarians_reputation: -50 } }).crimsonIsle).toMatchObject({ magesReputation: 100, barbariansReputation: -50 });
  });

  it("reads crafted minion variants from modern member fields without calling them slots", () => {
    const result = summarizeProgression({ player_data: { crafted_generators: ["COBBLESTONE_1", "COBBLESTONE_2", "COAL_1"] } });
    expect(result.minions).toMatchObject({ craftedVariants: 3, craftedTypes: 2 });
    expect((result.minions as Record<string, unknown>).craftedSlots).toBeUndefined();
  });
});
