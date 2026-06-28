import { describe, expect, it } from "vitest";
import { buildPlayerRatings, computeSkillAverage, summarizeSlayerTotals } from "../src/metrics.js";

describe("skill average", () => {
  it("averages only the eight counted skills and ignores carpentry/runecrafting", () => {
    const result = computeSkillAverage({
      farming: { level: 50, xpInLevel: 0, xpForNextLevel: 100 },
      mining: { level: 40, xpInLevel: 50, xpForNextLevel: 100 },
      combat: { level: 30 },
      foraging: { level: 30 },
      fishing: { level: 30 },
      enchanting: { level: 30 },
      alchemy: { level: 30 },
      taming: { level: 30 },
      carpentry: { level: 50 },
      runecrafting: { level: 25 }
    });

    // (50+40+30*6)/8 = 33.75
    expect(result?.skillAverage).toBe(33.75);
    expect(result?.countedSkills).toBe(8);
    // mining has half a level of progress -> true average slightly higher
    expect(result?.trueSkillAverage as number).toBeGreaterThan(33.75);
  });

  it("reports missing skills when some are private", () => {
    const result = computeSkillAverage({ farming: { level: 40 }, mining: { level: 40 } });
    expect(result?.countedSkills).toBe(2);
    expect(result?.missingSkills).toContain("combat");
  });
});

describe("slayer totals", () => {
  it("sums slayer xp and levels across bosses", () => {
    const totals = summarizeSlayerTotals({
      zombie: { xp: 1_000_000, tier: 9 },
      spider: { xp: 500_000, tier: 7 },
      wolf: { xp: 250_000, tier: 5 }
    });

    expect(totals?.totalXp).toBe(1_750_000);
    expect(totals?.totalSlayerLevels).toBe(21);
  });
});

describe("player ratings", () => {
  it("combines headline metrics", () => {
    const ratings = buildPlayerRatings({
      skillLevels: { farming: { level: 50 }, mining: { level: 50 }, combat: { level: 50 } },
      slayers: { zombie: { xp: 1_000_000, tier: 9 } },
      catacombsLevel: 42,
      magicalPower: 1200,
      skyblockLevel: 350
    });

    expect(ratings?.skyblockLevel).toBe(350);
    expect(ratings?.catacombsLevel).toBe(42);
    expect(ratings?.magicalPower).toBe(1200);
    expect(ratings?.totalSlayerXp).toBe(1_000_000);
    expect(ratings?.skillAverage).toBe(50);
  });
});
