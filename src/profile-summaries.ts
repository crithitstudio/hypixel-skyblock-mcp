import type { JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject } from "./utils.js";

/** Uses reported catches only; an omitted fish or tier remains unknown. */
export function summarizeTrophyFish(value: unknown): JsonObject | undefined {
  const data = asRecord(value);
  if (!data) return undefined;
  const tiers = ["bronze", "silver", "gold", "diamond"];
  const ids = new Set<string>();
  for (const [key, value] of Object.entries(data)) {
    if (asNumber(value) === undefined) continue;
    const match = key.match(/^(.+)_(bronze|silver|gold|diamond)$/);
    if (match) ids.add(match[1]!);
  }
  const fish = [...ids].sort().map((id) => {
    const catches = Object.fromEntries(tiers.flatMap((tier) => {
      const count = asNumber(data[`${id}_${tier}`]);
      return count !== undefined ? [[tier, count]] : [];
    }));
    return compactObject({
      id,
      totalCaught: asNumber(data[id]),
      highestTier: [...tiers].reverse().find((tier) => (catches[tier] ?? 0) > 0),
      catches
    });
  });
  return compactObject({
    totalCaught: asNumber(data.total_caught),
    rewardsClaimed: asArray(data.rewards)?.length,
    rewards: asArray(data.rewards),
    trackedFish: fish.length,
    fish: fish.slice(0, 100),
    truncated: fish.length > 100
  });
}

/** Compact history facts; medals are not inferred from rank or collection counts. */
export function summarizeFarmingContests(value: unknown): JsonObject | undefined {
  const data = asRecord(value);
  if (!data) return undefined;
  const contests = asRecord(data.contests);
  const bestByCrop: Record<string, number> = {};
  let claimed = 0;
  for (const [id, value] of Object.entries(contests ?? {})) {
    const contest = asRecord(value);
    if (!contest) continue;
    const crop = asString(contest.crop) ?? id.split(":").slice(2).join(":");
    const collected = asNumber(contest.collected);
    if (crop && collected !== undefined) bestByCrop[crop] = Math.max(bestByCrop[crop] ?? 0, collected);
    if (contest.claimed_rewards === true) claimed++;
  }
  return compactObject({
    contestCount: contests ? Object.keys(contests).length : undefined,
    rewardsClaimed: contests ? claimed : undefined,
    medals: asRecord(data.medals_inv),
    perks: asRecord(data.perks),
    bestByCrop,
    uniqueGoldCrops: asArray(data.unique_golds2) ?? asArray(data.unique_golds)
  });
}
