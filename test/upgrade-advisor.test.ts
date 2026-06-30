import { describe, expect, it } from "vitest";
import { buildUpgradeAdvice } from "../src/upgrade-advisor.js";
import type { UpgradeAdviceInputs } from "../src/upgrade-advisor.js";

const ESSENCE_UPGRADES = {
  perPiece: [
    { skyblockId: "NECRON_CHESTPLATE", name: "Necron's Chestplate", fromStar: 3, toStar: 5, essenceType: "WITHER", essence: 200, estimatedCoins: 8_000_000 },
    { skyblockId: "NECRON_HELMET", name: "Necron's Helmet", fromStar: 0, toStar: 5, essenceType: "WITHER", essence: 350, estimatedCoins: 2_500_000 }
  ]
};

type Entry = {
  source: string;
  action: string;
  coinCost?: number;
  coinCostExact?: boolean;
  confidence: string;
  caveats?: string[];
  target: Record<string, unknown>;
  prerequisites?: string[];
};

function run(overrides: Partial<UpgradeAdviceInputs> = {}): {
  upgrades: Entry[];
  coverage: Record<string, unknown>;
  notes: string[];
  primaryRole?: string;
} {
  const result = buildUpgradeAdvice({
    requestedSources: [],
    accessorySuggestions: [],
    lowbinConfigured: false,
    limit: 20,
    ...overrides
  });
  return result as unknown as {
    upgrades: Entry[];
    coverage: Record<string, unknown>;
    notes: string[];
    primaryRole?: string;
  };
}

describe("upgrade advisor", () => {
  it("builds ranked star upgrades from essence data, cheapest first", () => {
    const { upgrades, coverage } = run({ requestedSources: ["star"], essenceUpgrades: ESSENCE_UPGRADES });

    expect(upgrades).toHaveLength(2);
    // 2.5M helmet ranks before 8M chestplate
    expect(upgrades[0]!.target.skyblockId).toBe("NECRON_HELMET");
    expect(upgrades[1]!.target.skyblockId).toBe("NECRON_CHESTPLATE");
    expect(upgrades[0]!.source).toBe("star");
    expect(upgrades[0]!.confidence).toBe("estimate");
    expect(upgrades[0]!.coinCost).toBe(2_500_000);
    expect(upgrades[0]!.coinCostExact).toBe(false);
    expect(upgrades[0]!.action).toContain("0★ → 5★");
    expect(upgrades[0]!.prerequisites?.[0]).toContain("WITHER essence");
    expect(coverage.pricedSources).toEqual(["star"]);
  });

  it("prices an accessory upgrade when a lowest-BIN map provides the target", () => {
    const { upgrades, coverage } = run({
      requestedSources: ["accessory"],
      accessorySuggestions: ["Upgrade SPIDER_TALISMAN → SPIDER_ARTIFACT"],
      accessoryPrices: new Map([["SPIDER_ARTIFACT", 1_200_000]]),
      lowbinConfigured: true
    });

    expect(upgrades).toHaveLength(1);
    const entry = upgrades[0]!;
    expect(entry.source).toBe("accessory");
    expect(entry.target.skyblockId).toBe("SPIDER_ARTIFACT");
    expect(entry.target.fromTier).toBe("SPIDER_TALISMAN");
    expect(entry.coinCost).toBe(1_200_000);
    expect(entry.confidence).toBe("estimate");
    // carries auction caveats so the model hedges on a single lowest-BIN datapoint
    expect(entry.caveats?.some((c) => c.toLowerCase().includes("troll"))).toBe(true);
    expect(coverage.pricedSources).toEqual(["accessory"]);
  });

  it("keeps an unpriceable accessory upgrade as descriptive and points at config", () => {
    const { upgrades, coverage } = run({
      requestedSources: ["accessory"],
      accessorySuggestions: ["Upgrade BAT_TALISMAN → BAT_ARTIFACT"],
      lowbinConfigured: false
    });

    expect(upgrades).toHaveLength(1);
    const entry = upgrades[0]!;
    expect(entry.confidence).toBe("descriptive");
    expect(entry.coinCost).toBeUndefined();
    expect(entry.caveats?.[0]).toContain("SKYBLOCK_LOWEST_BIN_URL");
    expect(coverage.describedSources).toEqual(["accessory"]);
    expect(coverage.pricedSources).toEqual([]);
  });

  it("ranks priced upgrades before cost-unknown ones", () => {
    const { upgrades } = run({
      requestedSources: ["star", "accessory"],
      essenceUpgrades: ESSENCE_UPGRADES,
      accessorySuggestions: ["Upgrade BAT_TALISMAN → BAT_ARTIFACT"],
      lowbinConfigured: false
    });

    expect(upgrades).toHaveLength(3);
    expect(upgrades.map((u) => u.confidence)).toEqual(["estimate", "estimate", "descriptive"]);
    expect(upgrades[2]!.source).toBe("accessory");
  });

  it("filters priced upgrades above budgetCoins but keeps descriptive ones", () => {
    const { upgrades, notes } = run({
      requestedSources: ["star", "accessory"],
      essenceUpgrades: ESSENCE_UPGRADES,
      accessorySuggestions: ["Upgrade BAT_TALISMAN → BAT_ARTIFACT"],
      lowbinConfigured: false,
      budgetCoins: 3_000_000
    });

    const ids = upgrades.map((u) => u.target.skyblockId);
    expect(ids).toContain("NECRON_HELMET"); // 2.5M <= budget
    expect(ids).not.toContain("NECRON_CHESTPLATE"); // 8M > budget, dropped
    expect(ids).toContain("BAT_ARTIFACT"); // descriptive, kept
    expect(notes.some((n) => n.includes("budgetCoins"))).toBe(true);
  });

  it("reports unsupported sources with a reason instead of inventing advice", () => {
    const { coverage, upgrades } = run({ requestedSources: ["reforge", "enchant", "hotm", "pet"] });

    expect(upgrades).toEqual([]);
    const unsupported = coverage.unsupportedSources as Array<{ source: string; reason: string }>;
    expect(unsupported.map((u) => u.source).sort()).toEqual(["enchant", "hotm", "pet", "reforge"]);
    expect(unsupported.every((u) => u.reason.length > 0)).toBe(true);
  });

  it("gates sources: requesting only accessory ignores star data", () => {
    const { upgrades } = run({
      requestedSources: ["accessory"],
      essenceUpgrades: ESSENCE_UPGRADES,
      accessorySuggestions: []
    });
    expect(upgrades).toEqual([]);
  });

  it("honors the limit", () => {
    const { upgrades } = run({ requestedSources: ["star"], essenceUpgrades: ESSENCE_UPGRADES, limit: 1 });
    expect(upgrades).toHaveLength(1);
  });
});
