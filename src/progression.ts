import { gardenLevelFromXp, skyblockLevelFromExperience, slayerTierFromRecord } from "./levels.js";
import { summarizeHotfTree, summarizeHotmTree } from "./skill-trees.js";
import type { JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject, getPath } from "./utils.js";

export function summarizeProgression(member: JsonObject): JsonObject {
  const leveling = asRecord(member.leveling);
  const miningCore = asRecord(member.mining_core);
  const foragingCore = asRecord(member.foraging_core);
  const fairySoul = asRecord(member.fairy_soul);
  const skillTree = asRecord(member.skill_tree);
  const gardenPlayer = asRecord(member.garden_player_data);
  const sbXp = asNumber(leveling?.experience);

  return compactObject({
    skyblockLevel: sbXp !== undefined ? skyblockLevelFromExperience(sbXp) : undefined,
    fairySouls: fairySoul
      ? compactObject({
          collected: asNumber(fairySoul.total_collected),
          exchanges: asNumber(fairySoul.fairy_exchanges),
          unspent: asNumber(fairySoul.unspent_souls),
          totalAvailable: 273
        })
      : undefined,
    hotm: summarizeHotmTree(skillTree, miningCore),
    hotf: summarizeHotfTree(skillTree, foragingCore),
    milestones: summarizeMilestones(leveling),
    garden: summarizeGardenProgress(member, gardenPlayer),
    slayerTiers: summarizeSlayerTiers(member),
    minions: summarizeMinions(member),
    bestiary: summarizeBestiary(member),
    crimsonIsle: summarizeCrimsonIsle(member),
    rift: summarizeRift(member),
    essence: summarizeEssence(member)
  });
}

function summarizeMilestones(leveling: JsonObject | undefined): JsonObject | undefined {
  if (!leveling) {
    return undefined;
  }

  const completions = asRecord(leveling.completions);

  return compactObject({
    nucleusRuns: asNumber(completions?.NUCLEUS_RUNS),
    highestPetScore: asNumber(leveling.highest_pet_score),
    completedTaskCount: asArray(leveling.completed_tasks)?.length
  });
}

function summarizeGardenProgress(member: JsonObject, gardenPlayer: JsonObject | undefined): JsonObject | undefined {
  const gardenExperience = asNumber(member.garden_experience) ?? asNumber(getPath(member, ["garden", "garden_experience"]));

  if (gardenExperience === undefined && !gardenPlayer) {
    return undefined;
  }

  return compactObject({
    level: gardenExperience !== undefined ? gardenLevelFromXp(gardenExperience) : undefined,
    copper: asNumber(gardenPlayer?.copper),
    greenhouseCrops: asArray(gardenPlayer?.discovered_greenhouse_crops)
  });
}

function summarizeSlayerTiers(member: JsonObject): JsonObject | undefined {
  const slayer =
    asRecord(getPath(member, ["slayer", "slayer_bosses"])) ?? asRecord(member.slayer_bosses);

  if (!slayer) {
    return undefined;
  }

  const result: JsonObject = {};

  for (const [boss, value] of Object.entries(slayer)) {
    const record = asRecord(value);
    if (!record) {
      continue;
    }

    result[boss] = compactObject({
      tier: slayerTierFromRecord(asRecord(record.claimed_levels)),
      xp: asNumber(record.xp)
    });
  }

  return result;
}

function summarizeMinions(member: JsonObject): JsonObject | undefined {
  const playerData = asRecord(member.player_data);
  const generators = asRecord(playerData?.generators) ?? asRecord(member.generators);
  const unlocked = asArray(playerData?.unlocked_generators) ?? asArray(member.unlocked_generators);

  if (!generators && !unlocked?.length) {
    return undefined;
  }

  const crafted = generators ? Object.keys(generators).length : 0;

  return compactObject({
    craftedSlots: crafted,
    unlockedTypes: unlocked?.length,
    uniqueTypes: unlocked
  });
}

function summarizeBestiary(member: JsonObject): JsonObject | undefined {
  const bestiary =
    asRecord(member.bestiary) ??
    asRecord(getPath(member, ["player_data", "bestiary"])) ??
    asRecord(getPath(member, ["bestiary", "kills"]));

  if (!bestiary) {
    return undefined;
  }

  const kills = asRecord(bestiary.kills) ?? bestiary;
  const entries = Object.entries(kills).filter(([, value]) => typeof value === "number");
  const totalKills = entries.reduce((sum, [, value]) => sum + (value as number), 0);

  return compactObject({
    trackedMobs: entries.length,
    totalKills: totalKills || undefined,
    milestonesClaimed: asArray(bestiary.milestone_claimed)?.length ?? asArray(bestiary.milestones)?.length
  });
}

function summarizeCrimsonIsle(member: JsonObject): JsonObject | undefined {
  const nether = asRecord(member.nether_island_player_data);
  if (!nether) {
    return undefined;
  }

  const kuudra = asRecord(nether.kuudra_completed_tiers) ?? asRecord(nether.kuudra_tiers);
  // Values are completion counts; tolerate older boolean-style data too.
  const kuudraCounts = kuudra
    ? Object.values(kuudra).map((value) => asNumber(value) ?? (value === true ? 1 : 0))
    : undefined;

  return compactObject({
    selectedFaction: asString(nether.selected_faction) ?? asString(getPath(nether, ["faction", "selected"])),
    magesReputation: asNumber(getPath(nether, ["reputation", "mages"])),
    barbariansReputation: asNumber(getPath(nether, ["reputation", "barbarians"])),
    kuudraTiersUnlocked: kuudraCounts ? kuudraCounts.filter((count) => count > 0).length : undefined,
    kuudraRunsCompleted: kuudraCounts ? kuudraCounts.reduce((sum, count) => sum + count, 0) : undefined,
    abiphoneContacts: asArray(getPath(nether, ["abiphone", "active_contacts"]))?.length ??
      asArray(nether.abiphone_contact_selected)?.length,
    dojo: asRecord(nether.dojo)
  });
}

function summarizeRift(member: JsonObject): JsonObject | undefined {
  const rift = asRecord(member.rift);
  if (!rift) {
    return undefined;
  }

  return compactObject({
    motes: asNumber(getPath(member, ["currencies", "motes_purse"])),
    lifetimeMotes: asNumber(rift.lifetime_motes),
    visitedZones: asArray(rift.visited_zones)?.length,
    completedQuests: Object.keys(asRecord(rift.quests) ?? {}).length,
    gallery: asRecord(rift.gallery_trophies)
  });
}

export function summarizeEssence(member: JsonObject): JsonObject | undefined {
  const essence = asRecord(getPath(member, ["currencies", "essence"])) ?? asRecord(member.essence);
  if (!essence) {
    return undefined;
  }

  const result: JsonObject = {};

  for (const [type, value] of Object.entries(essence)) {
    const record = asRecord(value);
    result[type] = compactObject({
      current: asNumber(record?.current) ?? asNumber(value),
      total: asNumber(record?.total)
    });
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

export function summarizeMuseumMember(museumData: JsonObject | undefined, memberUuid: string | undefined): JsonObject | undefined {
  const members = asRecord(asRecord(museumData?.data)?.members) ?? asRecord(getPath(museumData, ["data", "members"]));
  if (!members || !memberUuid) {
    return undefined;
  }

  const member = asRecord(members[memberUuid]);
  if (!member) {
    return undefined;
  }

  const items = asArray(member.items) ?? [];
  const types = new Set(
    items
      .map((item) => asString(asRecord(item)?.type))
      .filter((value): value is string => Boolean(value))
  );

  return compactObject({
    value: asNumber(member.value),
    itemCount: items.length,
    uniqueTypes: types.size,
    categories: [...types].slice(0, 20)
  });
}
