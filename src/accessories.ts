import benchmarks from "./benchmarks.json" with { type: "json" };
import type { JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject } from "./utils.js";

// Accessory upgrade chains, lowest tier first. Only real, existing SkyBlock item
// IDs are listed (verified against /v2/resources/skyblock/items): Wolf, for
// example, caps at a Ring with no Artifact tier. Owning a lower tier while a
// higher one exists means the upgrade is still available.
const ACCESSORY_UPGRADE_CHAINS: string[][] = [
  ["SPIDER_TALISMAN", "SPIDER_RING", "SPIDER_ARTIFACT"],
  ["WOLF_TALISMAN", "WOLF_RING"],
  ["ZOMBIE_TALISMAN", "ZOMBIE_RING", "ZOMBIE_ARTIFACT"],
  ["SEA_CREATURE_TALISMAN", "SEA_CREATURE_RING", "SEA_CREATURE_ARTIFACT"],
  ["FEATHER_TALISMAN", "FEATHER_RING", "FEATHER_ARTIFACT"],
  ["RED_CLAW_TALISMAN", "RED_CLAW_RING", "RED_CLAW_ARTIFACT"],
  ["BAT_TALISMAN", "BAT_RING", "BAT_ARTIFACT"]
];

export function analyzeAccessoryBag(memberSummary: JsonObject | undefined): JsonObject | undefined {
  const bag = asRecord(memberSummary?.accessoryBag);
  if (!bag) {
    return undefined;
  }

  const mp = asNumber(bag.highestMagicalPower) ?? 0;
  const selectedPower = asString(bag.selectedPower);
  const unlocked = new Set((asArray(bag.unlockedPowers) ?? []).map((value) => asString(value)?.toLowerCase()).filter(Boolean));

  return compactObject({
    magicalPower: mp,
    selectedPower,
    unlockedPowers: [...unlocked],
    benchmark: benchmarks.accessories,
    tuning: bag.tuning,
    issues: buildAccessoryIssues(mp)
  });
}

function buildAccessoryIssues(mp: number): string[] {
  const issues: string[] = [];

  if (mp < benchmarks.accessories.mid) {
    issues.push(`Magical Power ${mp} is below the midgame benchmark (${benchmarks.accessories.mid}).`);
  } else if (mp < benchmarks.accessories.endgame) {
    issues.push(`Magical Power ${mp} is below the endgame benchmark (${benchmarks.accessories.endgame}).`);
  }

  return issues;
}

export function suggestAccessoryUpgrades(accessoryItems: { skyblockId?: string }[] | undefined): string[] {
  if (!accessoryItems?.length) {
    return [];
  }

  const owned = new Set(
    accessoryItems
      .map((item) => asString(item.skyblockId)?.toUpperCase())
      .filter((value): value is string => Boolean(value))
  );

  const suggestions: string[] = [];

  for (const chain of ACCESSORY_UPGRADE_CHAINS) {
    const highestOwnedIndex = chain.reduce((acc, id, index) => (owned.has(id) ? index : acc), -1);
    if (highestOwnedIndex === -1 || highestOwnedIndex === chain.length - 1) {
      continue;
    }

    const from = chain[highestOwnedIndex]!;
    const to = chain[chain.length - 1]!;
    suggestions.push(`Upgrade ${from} → ${to}`);
  }

  return suggestions.slice(0, 8);
}
