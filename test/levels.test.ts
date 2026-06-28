import { describe, expect, it } from "vitest";
import {
  catacombsLevelFromXp,
  gardenLevelFromXp,
  petLevelFromExp,
  skillLevelFromXp,
  skyblockLevelFromExperience,
  summarizeSkillLevels
} from "../src/levels.js";

describe("skill levels", () => {
  it("uses official Hypixel skill tables instead of the legacy approximation", () => {
    expect(skillLevelFromXp(13_092_067, "farming").level).toBe(33);
    expect(skillLevelFromXp(28_032_922, "mining").level).toBe(41);
    expect(skillLevelFromXp(21_655_093, "combat").level).toBe(38);
    expect(skillLevelFromXp(70_848, "runecrafting").level).toBe(23);
  });

  it("does not mark midgame farming XP as level 60", () => {
    const farming = skillLevelFromXp(13_092_067, "farming");
    expect(farming.level).toBeLessThan(40);
    expect(farming.maxLevel).toBe(60);
  });

  it("summarizes each skill with its own table", () => {
    const levels = summarizeSkillLevels({
      farming: 13_092_067,
      runecrafting: 70_848
    });

    expect(levels.farming?.level).toBe(33);
    expect(levels.runecrafting?.level).toBe(23);
  });
});

describe("catacombs levels", () => {
  it("maps catacombs XP to dungeon level using the official NEU table", () => {
    expect(catacombsLevelFromXp(2_001_142).level).toBe(28);
    expect(catacombsLevelFromXp(569_809_640).level).toBe(50);
    expect(catacombsLevelFromXp(177_559_640).level).toBe(45);
  });

  it("uses the same table for dungeon class XP", () => {
    const cata = catacombsLevelFromXp(1_684_640);
    expect(cata.level).toBe(28);
    expect(cata.xpInLevel).toBe(0);
    expect(cata.xpForNextLevel).toBe(600_000);
  });
});

describe("skyblock level", () => {
  it("uses a flat 100 XP per level above level 100", () => {
    // 49,412 XP -> level 494 (regression: the old tiered formula reported 317).
    expect(skyblockLevelFromExperience(49_412).level).toBe(494);
    expect(skyblockLevelFromExperience(10_093).level).toBe(100);
    expect(skyblockLevelFromExperience(8_275).level).toBe(82);
    const level = skyblockLevelFromExperience(49_412);
    expect(level.xpInLevel).toBe(12);
    expect(level.xpForNextLevel).toBe(100);
  });
});

describe("pet levels", () => {
  it("matches the official total-XP-to-level-100 tables per rarity", () => {
    expect(petLevelFromExp(5_624_785, "COMMON").level).toBe(100);
    expect(petLevelFromExp(5_624_784, "COMMON").level).toBe(99);
    expect(petLevelFromExp(8_644_220, "UNCOMMON").level).toBe(100);
    expect(petLevelFromExp(12_626_665, "RARE").level).toBe(100);
    expect(petLevelFromExp(25_353_230, "LEGENDARY").level).toBe(100);
    // Mythic shares the legendary curve.
    expect(petLevelFromExp(25_353_230, "MYTHIC").level).toBe(100);
  });

  it("levels higher-rarity pets more slowly for the same XP", () => {
    const exp = 1_000_000;
    // Legendary pets cost more XP per level, so at equal XP they are a lower level.
    expect(petLevelFromExp(exp, "LEGENDARY").level).toBeLessThan(petLevelFromExp(exp, "COMMON").level);
  });

  it("caps normal pets at 100 and dragons at 200", () => {
    expect(petLevelFromExp(999_999_999, "LEGENDARY").level).toBe(100);
    expect(petLevelFromExp(999_999_999, "LEGENDARY", "GOLDEN_DRAGON").maxLevel).toBe(200);
    expect(petLevelFromExp(999_999_999, "LEGENDARY", "GOLDEN_DRAGON").level).toBe(200);
    // Rose Dragon also caps at 200 (regression: it used to cap at 100).
    expect(petLevelFromExp(999_999_999, "LEGENDARY", "ROSE_DRAGON").maxLevel).toBe(200);
    expect(petLevelFromExp(999_999_999, "LEGENDARY", "ROSE_DRAGON").level).toBe(200);
  });

  it("uses the NEU dragon curve for levels 100-200 (not a flat increment)", () => {
    // Legendary 1->100 costs 25,353,230 XP; the dragon curve then charges 0 for
    // 100->101 and 5,555 for 101->102, so 25,358,785 XP reaches level 102.
    // (Regression: the old flat-1,886,700 step under-leveled dragons past 100.)
    expect(petLevelFromExp(25_358_785, "LEGENDARY", "GOLDEN_DRAGON").level).toBe(102);
    // Total XP to max a dragon is the known 210,255,385 figure.
    const maxed = petLevelFromExp(210_255_385, "LEGENDARY", "GOLDEN_DRAGON");
    expect(maxed.level).toBe(200);
    expect(maxed.xpForNextLevel).toBe(0);
    // One XP short of max stays at level 199.
    expect(petLevelFromExp(210_255_384, "LEGENDARY", "GOLDEN_DRAGON").level).toBe(199);
  });
});

describe("garden levels", () => {
  // The Garden has 15 levels; a freshly unlocked Garden is level 1 at 0 XP and
  // Garden XV is reached at 60,120 XP (NEU/wiki garden_exp table).
  it("uses the real Garden XP table and caps at level 15", () => {
    expect(gardenLevelFromXp(0).level).toBe(1);
    expect(gardenLevelFromXp(0).maxLevel).toBe(15);
    expect(gardenLevelFromXp(70).level).toBe(2);
    expect(gardenLevelFromXp(10_120).level).toBe(10);
    expect(gardenLevelFromXp(10_119).level).toBe(9);
    expect(gardenLevelFromXp(60_120).level).toBe(15);
    // Excess XP cannot push past the level 15 cap.
    expect(gardenLevelFromXp(1_000_000).level).toBe(15);
  });
});
