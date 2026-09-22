import benchmarks from "./benchmarks.json" with { type: "json" };
import { analyzeAccessoryBag, suggestAccessoryUpgrades } from "./accessories.js";
import { summarizeEquippedGear, summarizeGearQuality, summarizeLoadouts } from "./gear.js";
import type { HypixelClient } from "./hypixelClient.js";
import { summarizeEquippedEssenceUpgrades } from "./essence-costs.js";
import type { EquippedGearPiece } from "./essence-costs.js";
import { catacombsLevelFromXp, gardenLevelFromXp, petLevelFromExp, summarizeSkillLevels } from "./levels.js";
import { buildPlayerRatings } from "./metrics.js";
import { summarizeMayor } from "./mayor.js";
import { summarizeMuseumMember, summarizeProgression } from "./progression.js";
import { findNbtDataLocations } from "./nbt.js";
import { countUnplacedNucleusCrystals } from "./skill-trees.js";
import {
  getBazaar,
  getSkyblockProfileContext,
  getSkyblockResource
} from "./skyblock.js";
import type { DecodedInventory, JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject, getPath, sortByNumeric } from "./utils.js";

export type AuditFocus =
  | "mining"
  | "farming"
  | "foraging"
  | "dungeons"
  | "slayers"
  | "money"
  | "combat"
  | "skills"
  | "accessories"
  | "pets"
  | "progression";

export type AuditGap = {
  area: string;
  severity: "high" | "medium" | "low";
  message: string;
  evidence?: JsonObject;
};

export type AuditOptions = {
  username?: string;
  uuid?: string;
  profileId?: string;
  profileName?: string;
  selectedOnly?: boolean;
  memberUsername?: string;
  memberUuid?: string;
  focus?: string[];
  includeEconomy?: boolean;
  includeMayor?: boolean;
};

export async function getSkyblockAudit(client: HypixelClient, options: AuditOptions): Promise<JsonObject> {
  const focus = normalizeFocus(options.focus);
  const profileContext = await getSkyblockProfileContext(client, {
    ...options,
    decodeInventories: true,
    includeGarden: true,
    includeMuseum: true,
    includeRawMember: true,
    includeItemDetails: false,
    maxItemsPerInventory: 500,
    maxInventorySections: 120,
    inventorySectionTypes: ["armor", "equipment", "loadout", "accessory_bag", "inventory"],
    maxLoreLines: 4
  });

  const member = asRecord(profileContext.member);
  const rawMember = asRecord(profileContext.rawMember);
  const progression = rawMember ? summarizeProgression(rawMember) : undefined;
  const warnings: string[] = [];
  for (const endpoint of ["garden", "museum"]) {
    const error = asString(asRecord(profileContext[endpoint])?.error);
    if (error) warnings.push(`${endpoint} data unavailable: ${error}`);
  }
  const decodedInventories = asArray(profileContext.decodedInventories) as DecodedInventory[] | undefined;
  const skillLevels = buildSkillLevelDetails(member);
  const skillsForGear = toSkillLevelMap(skillLevels);
  const equipped = summarizeEquippedGear(decodedInventories);
  const loadouts = summarizeLoadouts(decodedInventories);
  const accessoryAnalysis = analyzeAccessoryBag(member);
  const accessorySections = decodedInventories?.filter((section) => section.sectionType === "accessory_bag") ?? [];
  const accessoryLocations = findNbtDataLocations(rawMember).filter((section) => section.sectionType === "accessory_bag");
  const accessoryInventoryComplete = accessoryLocations.length > 0 &&
    accessoryLocations.every((location) => accessorySections.some((section) => section.path === location.path && !section.error && !section.truncated));
  const accessoryUpgrades = accessoryInventoryComplete
    ? suggestAccessoryUpgrades(accessorySections.flatMap((section) => section.items))
    : [];
  if (!accessoryInventoryComplete) warnings.push("Accessory inventory is unavailable or incomplete; upgrade suggestions are omitted.");
  for (const section of decodedInventories ?? []) {
    if (section.error) warnings.push(`Inventory section ${section.path} could not be decoded: ${section.error}`);
    else if (section.truncated) warnings.push(`Inventory section ${section.path} is truncated (${section.shownItems}/${section.itemCount} items).`);
  }
  const gearQuality = summarizeGearQuality(equipped, skillsForGear);
  const meta = asRecord(profileContext.meta);
  const gaps = detectGaps({
    focus,
    member,
    progression,
    skills: skillsForGear,
    equipped,
    gearQuality,
    accessoryAnalysis,
    garden: asRecord(getPath(profileContext, ["garden", "data", "garden"])),
    museum: asRecord(getPath(profileContext, ["museum", "data", "members"])),
    memberUuid: asString(meta?.selectedMemberUuid)
  });

  const optional = async (label: string, operation: Promise<JsonObject | undefined>): Promise<JsonObject | undefined> => {
    try { return await operation; }
    catch (error) {
      warnings.push(`${label} unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  };

  const [mayor, bazaar, essenceUpgrades] = await Promise.all([
    options.includeMayor === false
      ? Promise.resolve(undefined)
      : optional("Mayor", getSkyblockResource(client, { kind: "election", includeRaw: true })),
    options.includeEconomy === false
      ? Promise.resolve(undefined)
      : optional("Bazaar", buildPersonalizedBazaar(client, member)),
    options.includeEconomy === false
      ? Promise.resolve(undefined)
      : optional("Essence upgrade prices", summarizeEquippedEssenceUpgrades(client, collectEquippedPieces(equipped)))
  ]);

  const upgradeGap = buildEssenceUpgradeGap(focus, essenceUpgrades);
  const allGaps = upgradeGap ? sortGaps([...gaps, upgradeGap]) : gaps;

  const mayorSummary = summarizeMayor(mayor);
  const nextActions = buildNextActions(allGaps, mayorSummary);

  const dungeonLevels = summarizeDungeonLevels(member);
  const ratings = buildPlayerRatings({
    skillLevels,
    slayers: asRecord(member?.slayers),
    catacombsLevel: asNumber(getPath(dungeonLevels, ["catacombs", "level"])),
    magicalPower: asNumber(getPath(member, ["accessoryBag", "highestMagicalPower"])),
    skyblockLevel: asNumber(getPath(progression, ["skyblockLevel", "level"]))
  });

  const payload = compactObject({
    generatedAt: new Date().toISOString(),
    focus,
    summary: buildSummary(member, progression, profileContext, equipped),
    ratings,
    skills: skillLevels,
    progression,
    slayers: member?.slayers,
    dungeons: dungeonLevels,
    pets: summarizePetLevels(member),
    trophyFish: member?.trophyFish,
    farmingContests: member?.farmingContests,
    accessories: compactObject({
      ...accessoryAnalysis,
      inventoryComplete: accessoryInventoryComplete,
      upgradeSuggestions: accessoryUpgrades
    }),
    gear: compactObject({
      equipped,
      loadouts,
      quality: gearQuality,
      upgradeCosts: essenceUpgrades
    }),
    garden: summarizeGardenAudit(profileContext.garden as JsonObject | undefined),
    economy: compactObject({
      purse: member?.purse,
      bank: getPath(profileContext, ["profile", "bank"]),
      essence: getPath(member, ["essence"]) ?? getPath(member, ["currencies", "essence"]),
      museum: extractMuseumSummary(profileContext.museum as JsonObject | undefined, asString(meta?.selectedMemberUuid)),
      bazaarSignals: bazaar
    }),
    gaps: allGaps,
    nextActions,
    mayor: mayorSummary,
    privacy: profileContext.privacy,
    warnings,
    meta: compactObject({
      profileSource: getPath(profileContext, ["meta", "profileSource"]),
      truncationNotes: [
        "Audit analyzes up to 500 items per section and 120 armor, equipment, loadout, accessory, and inventory sections; any incomplete sections are reported in warnings.",
        "Gear quality describes the currently equipped set only; stored gear may be stronger. Magical Power is the highest recorded API value.",
        "Use skyblock_storage for merged backpack/ender/vault/sack search.",
        "Use skyblock_inventory for raw per-section NBT decoding."
      ]
    })
  });

  return {
    ...payload,
    meta: {
      ...(payload.meta as JsonObject),
      approximateResponseBytes: JSON.stringify(payload).length
    }
  };
}

function defaultFocus(): AuditFocus[] {
  return [
    "mining",
    "foraging",
    "farming",
    "dungeons",
    "slayers",
    "money",
    "combat",
    "pets",
    "accessories",
    "skills",
    "progression"
  ];
}

function normalizeFocus(focus: string[] | undefined): AuditFocus[] {
  const allowed = new Set(defaultFocus());

  if (!focus?.length) {
    return defaultFocus();
  }

  return focus.filter((area): area is AuditFocus => allowed.has(area as AuditFocus));
}

function buildSkillLevelDetails(member: JsonObject | undefined): Record<string, JsonObject> | undefined {
  const skillLevels = asRecord(member?.skillLevels);
  if (skillLevels) {
    return Object.fromEntries(
      Object.entries(skillLevels)
        .map(([skill, value]) => {
          const record = asRecord(value);
          return record ? [skill, record] : undefined;
        })
        .filter((entry): entry is [string, JsonObject] => Boolean(entry))
    );
  }

  const rawSkills = asRecord(member?.skills);
  if (!rawSkills) {
    return undefined;
  }

  const numericSkills: Record<string, number> = {};

  for (const [skill, value] of Object.entries(rawSkills)) {
    const xp = asNumber(value);
    if (xp !== undefined) {
      numericSkills[skill] = xp;
    }
  }

  return summarizeSkillLevels(numericSkills) as unknown as Record<string, JsonObject>;
}

function toSkillLevelMap(skillLevels: Record<string, JsonObject> | undefined): Record<string, { level: number }> | undefined {
  if (!skillLevels) {
    return undefined;
  }

  const result: Record<string, { level: number }> = {};

  for (const [skill, value] of Object.entries(skillLevels)) {
    const level = asNumber(value.level);
    if (level !== undefined) {
      result[skill] = { level };
    }
  }

  return result;
}

function summarizeDungeonLevels(member: JsonObject | undefined): JsonObject | undefined {
  const dungeons = asRecord(member?.dungeons);
  if (!dungeons) {
    return undefined;
  }

  const classes = asRecord(dungeons.playerClasses);
  const classLevels: JsonObject = {};

  for (const [name, value] of Object.entries(classes ?? {})) {
    const xp = asNumber(asRecord(value)?.experience);
    if (xp !== undefined) {
      classLevels[name] = catacombsLevelFromXp(xp);
    }
  }

  const catacombs = asRecord(asRecord(dungeons.dungeonTypes)?.catacombs);
  const catacombsXp = asNumber(catacombs?.experience);

  return compactObject({
    selectedClass: dungeons.selectedClass,
    catacombs: catacombsXp !== undefined ? catacombsLevelFromXp(catacombsXp) : undefined,
    highestTierCompleted: catacombs?.highestTierCompleted,
    classLevels,
    dungeonTypes: dungeons.dungeonTypes
  });
}

function summarizePetLevels(member: JsonObject | undefined): JsonObject | undefined {
  const pets = asRecord(member?.pets);
  if (!pets) {
    return undefined;
  }

  const active = asRecord(pets.active);
  const activeExp = asNumber(active?.exp);

  return compactObject({
    count: pets.count,
    active: active
      ? compactObject({
          type: active.type,
          tier: active.tier,
          ...(activeExp !== undefined
            ? petLevelFromExp(activeExp, asString(active.tier) ?? "COMMON", asString(active.type))
            : {})
        })
      : undefined,
    topByExp: asArray(pets.topByExp)?.slice(0, 5)
  });
}

function buildSummary(
  member: JsonObject | undefined,
  progression: JsonObject | undefined,
  profileContext: JsonObject,
  equipped?: JsonObject
): JsonObject {
  const profile = asRecord(profileContext.profile);
  const fairySouls = asRecord(progression?.fairySouls);

  return compactObject({
    profileName: profile?.cuteName,
    profileId: profile?.profileId,
    purse: member?.purse,
    bank: profile?.bank,
    skyblockLevel: getPath(progression, ["skyblockLevel", "level"]),
    magicalPower: getPath(member, ["accessoryBag", "highestMagicalPower"]),
    fairySouls: asNumber(fairySouls?.collected) !== undefined
      ? `${fairySouls!.collected}/${asNumber(fairySouls!.totalAvailable) ?? benchmarks.fairySouls.total}`
      : undefined,
    nucleusRuns: getPath(progression, ["milestones", "nucleusRuns"]),
    primaryRole: asString(equipped?.inferredRole)
  });
}

function collectEquippedPieces(equipped: JsonObject | undefined): EquippedGearPiece[] {
  if (!equipped) {
    return [];
  }

  const pieces: EquippedGearPiece[] = [];
  for (const key of ["armor", "equipment"] as const) {
    for (const item of asArray(equipped[key]) ?? []) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }

      pieces.push({
        skyblockId: asString(record.skyblockId),
        name: asString(record.name),
        dungeonStars: asNumber(record.dungeonStars)
      });
    }
  }

  return pieces;
}

function buildEssenceUpgradeGap(focus: AuditFocus[], essenceUpgrades: JsonObject | undefined): AuditGap | undefined {
  if (!essenceUpgrades || (!focus.includes("dungeons") && !focus.includes("combat"))) {
    return undefined;
  }

  const total = asNumber(essenceUpgrades.estimatedTotalCoins);
  const pieces = asArray(essenceUpgrades.perPiece)?.length ?? 0;
  if (pieces === 0) {
    return undefined;
  }

  return {
    area: "dungeons",
    severity: "low",
    message: total !== undefined
      ? `Equipped gear is not fully starred: finishing the essence stars on ${pieces} piece(s) costs about ${total.toLocaleString()} coins.`
      : `Equipped gear is not fully starred: ${pieces} piece(s) have remaining essence upgrades, but missing component prices prevent a full cost estimate.`,
    evidence: compactObject({
      estimatedTotalCoins: total,
      pricedSubtotalCoins: essenceUpgrades.pricedSubtotalCoins,
      pricingComplete: essenceUpgrades.pricingComplete,
      unpriced: essenceUpgrades.unpriced,
      essenceByType: essenceUpgrades.essenceByType
    })
  };
}

function summarizeGardenAudit(garden: JsonObject | undefined): JsonObject | undefined {
  const data = asRecord(garden?.data);
  const gardenData = asRecord(data?.garden);
  if (!gardenData) {
    return undefined;
  }

  const experience = asNumber(gardenData.garden_experience);

  return compactObject({
    experience: gardenData.garden_experience,
    level: experience !== undefined ? gardenLevelFromXp(experience) : undefined,
    unlockedPlots: asArray(gardenData.unlocked_plots_ids)?.length,
    totalPlots: 24,
    commissionsCompleted: getPath(gardenData, ["commission_data", "total_completed"]),
    uniqueNpcsServed: getPath(gardenData, ["commission_data", "unique_npcs_served"]),
    activeCommissions: Object.keys(asRecord(gardenData.active_commissions) ?? {}).length,
    cropUpgrades: gardenData.crop_upgrade_levels,
    composterUpgrades: getPath(gardenData, ["composter_data", "upgrades"])
  });
}

function extractMuseumSummary(museum: JsonObject | undefined, memberUuid: string | undefined): JsonObject | undefined {
  return summarizeMuseumMember(museum, memberUuid);
}

async function buildPersonalizedBazaar(client: HypixelClient, member: JsonObject | undefined): Promise<JsonObject | undefined> {
  const collections = asRecord(getPath(member, ["collections", "top"]));
  if (!collections) {
    return undefined;
  }

  const topCollections = sortByNumeric(Object.entries(collections), ([, value]) => asNumber(value), "desc")
    .slice(0, 8)
    .map(([key]) => collectionToBazaarProduct(key))
    .filter((value): value is string => Boolean(value));

  if (!topCollections.length) {
    return undefined;
  }

  const bazaar = await getBazaar(client, { productIds: topCollections, limit: topCollections.length });
  return compactObject({
    basedOnCollections: topCollections,
    freshness: bazaar.freshness,
    caveats: bazaar.caveats,
    products: bazaar.products
  });
}

function collectionToBazaarProduct(collectionKey: string): string | undefined {
  const map: Record<string, string> = {
    REDSTONE: "ENCHANTED_REDSTONE_BLOCK",
    COAL: "ENCHANTED_COAL_BLOCK",
    DIAMOND: "ENCHANTED_DIAMOND",
    GEMSTONE_COLLECTION: "ROUGH_JADE_GEM",
    MITHRIL_ORE: "MITHRIL_ORE",
    WHEAT: "ENCHANTED_WHEAT",
    MELON: "ENCHANTED_MELON_BLOCK",
    POTATO_ITEM: "ENCHANTED_POTATO",
    CARROT_ITEM: "ENCHANTED_CARROT"
  };

  return map[collectionKey] ?? collectionKey;
}

function detectGaps(input: {
  focus: AuditFocus[];
  member?: JsonObject;
  progression?: JsonObject;
  skills?: Record<string, JsonObject>;
  equipped?: JsonObject;
  gearQuality?: JsonObject;
  accessoryAnalysis?: JsonObject;
  garden?: JsonObject;
  museum?: JsonObject;
  memberUuid?: string;
}): AuditGap[] {
  const gaps: AuditGap[] = [];

  if (input.focus.includes("accessories")) {
    const mp = asNumber(input.accessoryAnalysis?.magicalPower);
    if (mp !== undefined && mp < benchmarks.accessories.endgame) {
      gaps.push({
        area: "accessories",
        severity: mp < benchmarks.accessories.mid ? "high" : "medium",
        message: `Magical Power ${mp} is below the endgame benchmark (${benchmarks.accessories.endgame}).`,
        evidence: { magicalPower: mp, benchmark: benchmarks.accessories.endgame }
      });
    }

  }

  if (input.focus.includes("farming")) {
    const farmingLevel = asNumber(input.skills?.farming?.level) ?? 0;
    // Garden XP lives on the dedicated garden endpoint (input.garden), not on the
    // member object, so prefer it over the usually-absent member progression data.
    const gardenExp = asNumber(input.garden?.garden_experience);
    const gardenLevel =
      gardenExp !== undefined
        ? gardenLevelFromXp(gardenExp).level
        : asNumber(getPath(input.progression, ["garden", "level", "level"]));
    const plots = asArray(input.garden?.unlocked_plots_ids)?.length ?? asNumber(input.garden?.unlockedPlots);

    if (farmingLevel >= 40 && gardenLevel !== undefined && gardenLevel < benchmarks.garden.levelForFarming50) {
      gaps.push({
        area: "farming",
        severity: farmingLevel >= 50 ? "high" : "medium",
        message: `Farming ${farmingLevel} but Garden level ${gardenLevel} is behind.`,
        evidence: { farmingLevel, gardenLevel }
      });
    }

    if (farmingLevel >= 50 && plots !== undefined && plots < benchmarks.garden.plotsUnlockedLate) {
      gaps.push({
        area: "farming",
        severity: "medium",
        message: `Only ${plots}/24 garden plots unlocked for Farming ${farmingLevel}.`,
        evidence: { plotsUnlocked: plots }
      });
    }

    if (input.gearQuality?.farming === "weak") {
      gaps.push({
        area: "farming",
        severity: "medium",
        message: "Equipped/primary farming gear is still early-game.",
        evidence: { equipped: input.equipped }
      });
    }
  }

  if (input.focus.includes("mining")) {
    const hotm = asNumber(getPath(input.progression, ["hotm", "level"])) ?? 0;
    if (hotm > 0 && hotm < benchmarks.hotm.recommendedForCrystalHollows) {
      gaps.push({
        area: "mining",
        severity: "medium",
        message: `HOTM ${hotm} is below the Crystal Hollows benchmark (${benchmarks.hotm.recommendedForCrystalHollows}).`,
        evidence: { hotmLevel: hotm }
      });
    }

    if (hotm > 0 && hotm < benchmarks.hotm.recommendedForNucleus) {
      gaps.push({
        area: "mining",
        severity: "medium",
        message: `HOTM ${hotm} is below the nucleus benchmark (${benchmarks.hotm.recommendedForNucleus}).`,
        evidence: { hotmLevel: hotm }
      });
    }

    const crystals = asRecord(getPath(input.progression, ["hotm", "crystals"]));
    const unplaced = countUnplacedNucleusCrystals(crystals);

    if (unplaced > 0) {
      gaps.push({
        area: "mining",
        severity: "low",
        message: `${unplaced} nucleus crystal(s) found but not placed in the Crystal Nucleus.`,
        evidence: { unplacedCrystals: unplaced }
      });
    }
  }

  if (input.focus.includes("foraging")) {
    const whispersSpent = asNumber(getPath(input.progression, ["hotf", "whispers", "spent"]));
    const unlockedPerks = asNumber(getPath(input.progression, ["hotf", "unlockedPerks"]));

    if (whispersSpent !== undefined && whispersSpent < benchmarks.hotf.recommendedWhispersSpent) {
      gaps.push({
        area: "foraging",
        severity: "low",
        message: `Heart of the Forest investment (${whispersSpent} whispers spent) is still early.`,
        evidence: { whispersSpent, benchmark: benchmarks.hotf.recommendedWhispersSpent }
      });
    }

    if (unlockedPerks !== undefined && unlockedPerks < benchmarks.hotf.recommendedPerks) {
      gaps.push({
        area: "foraging",
        severity: "low",
        message: `Only ${unlockedPerks} HOTF perks unlocked.`,
        evidence: { unlockedPerks, benchmark: benchmarks.hotf.recommendedPerks }
      });
    }
  }

  if (input.focus.includes("dungeons")) {
    const dungeonSummary = asNumber(getPath(input.member, ["dungeons", "catacombsLevel"]));
    const wither = asNumber(getPath(input.member, ["essence", "WITHER", "current"])) ??
      asNumber(getPath(input.member, ["currencies", "essence", "WITHER", "current"]));
    const crimson = asNumber(getPath(input.member, ["essence", "CRIMSON", "current"])) ??
      asNumber(getPath(input.member, ["currencies", "essence", "CRIMSON", "current"]));

    if ((dungeonSummary ?? 0) >= 35 && wither !== undefined && wither < benchmarks.essence.witherForFiveStar / 10) {
      gaps.push({
        area: "dungeons",
        severity: "high",
        message: `Low Wither essence (${wither ?? 0}) for Catacombs ${dungeonSummary}.`,
        evidence: { witherEssence: wither, catacombsLevel: dungeonSummary }
      });
    }

    if ((dungeonSummary ?? 0) >= benchmarks.catacombs.masterModeEntry && wither !== undefined && wither < benchmarks.essence.witherForFiveStar / 5) {
      gaps.push({
        area: "dungeons",
        severity: "medium",
        message: `Wither essence (${wither ?? 0}) is low for Master Mode at Catacombs ${dungeonSummary}.`,
        evidence: { witherEssence: wither, catacombsLevel: dungeonSummary }
      });
    }

    const kuudraTiers = asNumber(getPath(input.progression, ["crimsonIsle", "kuudraRunsCompleted"])) ??
      asNumber(getPath(input.progression, ["crimsonIsle", "kuudraTiersUnlocked"])) ?? 0;
    if (crimson !== undefined && crimson < benchmarks.essence.crimsonForCrimsonGear && kuudraTiers > 0) {
      gaps.push({
        area: "dungeons",
        severity: "low",
        message: `Low Crimson essence (${crimson ?? 0}) for Kuudra/crimson gear upgrades.`,
        evidence: { crimsonEssence: crimson, kuudraTiersCompleted: kuudraTiers }
      });
    }

    if (input.gearQuality?.dungeons === "weak" || input.gearQuality?.dungeons === "mid") {
      gaps.push({
        area: "dungeons",
        severity: "medium",
        message: "Dungeon armor progression is behind current Catacombs level.",
        evidence: { gearQuality: input.gearQuality }
      });
    }
  }

  if (input.focus.includes("slayers")) {
    const tiers = asRecord(input.progression?.slayerTiers);
    for (const [boss, value] of Object.entries(tiers ?? {})) {
      const tier = asNumber(asRecord(value)?.tier);
      if (tier === undefined) continue;
      if (boss === "blaze" && tier === 0) {
        gaps.push({
          area: "slayers",
          severity: "medium",
          message: "No Inferno Demonlord slayer levels have been claimed.",
          evidence: { boss, tier }
        });
      }

      if (boss === "enderman" && tier < benchmarks.slayers.recommendedT5) {
        gaps.push({
          area: "slayers",
          severity: "medium",
          message: `Voidgloom slayer level ${tier} is below the benchmark (${benchmarks.slayers.recommendedT5}).`,
          evidence: { boss, tier }
        });
      }
    }
  }

  if (input.focus.includes("combat")) {
    const combatLevel = asNumber(input.skills?.combat?.level);
    if (combatLevel !== undefined && combatLevel < benchmarks.skills.recommendedForMidgame) {
      gaps.push({
        area: "combat",
        severity: combatLevel < 30 ? "high" : "medium",
        message: `Combat ${combatLevel} is below the midgame benchmark (${benchmarks.skills.recommendedForMidgame}).`,
        evidence: { combatLevel }
      });
    }

    if (input.gearQuality?.combat === "weak") {
      gaps.push({
        area: "combat",
        severity: "medium",
        message: "Equipped combat gear is behind your combat progression.",
        evidence: { gearQuality: input.gearQuality }
      });
    }
  }

  if (input.focus.includes("pets")) {
    const petScore = asNumber(getPath(input.progression, ["milestones", "highestPetScore"]));
    const activeLevel = asNumber(getPath(input.member, ["pets", "active", "level"])) ?? 0;

    if (petScore !== undefined && petScore < benchmarks.pets.recommendedScore) {
      gaps.push({
        area: "pets",
        severity: petScore < 80 ? "medium" : "low",
        message: `Pet score ${petScore} is below the benchmark (${benchmarks.pets.recommendedScore}).`,
        evidence: { petScore }
      });
    }

    if (activeLevel > 0 && activeLevel < 100) {
      gaps.push({
        area: "pets",
        severity: "low",
        message: `Active pet is only level ${activeLevel}.`,
        evidence: { activePetLevel: activeLevel }
      });
    }
  }

  if (input.focus.includes("skills")) {
    const enchanting = asNumber(input.skills?.enchanting?.level) ?? 0;
    const mining = asNumber(input.skills?.mining?.level);
    if (enchanting >= benchmarks.skills.recommendedForLategame && mining !== undefined && mining < benchmarks.skills.recommendedForMidgame) {
      gaps.push({
        area: "skills",
        severity: "low",
        message: `Enchanting ${enchanting} is strong but Mining ${mining} lags behind.`,
        evidence: { enchanting, mining }
      });
    }
  }

  if (input.focus.includes("money")) {
    const purse = asNumber(input.member?.purse);
    if (purse !== undefined && purse < 5_000_000) {
      gaps.push({
        area: "money",
        severity: purse < 1_000_000 ? "high" : "medium",
        message: `Low liquid purse (${purse.toLocaleString()} coins).`,
        evidence: { purse }
      });
    }
  }

  const fairyCollected = asNumber(getPath(input.progression, ["fairySouls", "collected"]));
  if (input.focus.includes("progression") && fairyCollected !== undefined && fairyCollected < benchmarks.fairySouls.total - 10) {
    gaps.push({
      area: "progression",
      severity: "low",
      message: `Fairy souls ${fairyCollected}/${benchmarks.fairySouls.total} are still incomplete.`,
      evidence: { fairySouls: fairyCollected }
    });
  }

  return sortGaps(gaps);
}

function sortGaps(gaps: AuditGap[]): AuditGap[] {
  const order = { high: 0, medium: 1, low: 2 };
  return [...gaps].sort((left, right) => order[left.severity] - order[right.severity]);
}

function buildNextActions(gaps: AuditGap[], mayor: unknown): string[] {
  const actions: string[] = [];

  for (const gap of gaps.slice(0, 5)) {
    switch (gap.area) {
      case "accessories":
        actions.push("Upgrade accessory bag MP and switch to a stronger accessory power.");
        break;
      case "farming":
        actions.push("Invest in garden plot unlocks, composter upgrades, and Cropie/Fermento armor.");
        break;
      case "foraging":
        actions.push("Spend Forest Whispers on HOTF perks and foraging fortune.");
        break;
      case "combat":
        actions.push("Raise Combat level and upgrade combat gear/pets for slayers and Kuudra.");
        break;
      case "pets":
        actions.push("Level relevant pets toward their reported level caps and review missing pet types and rarities.");
        break;
      case "mining":
        if ((asNumber(gap.evidence?.unplacedCrystals) ?? 0) > 0) {
          actions.push(
            "Place missing nucleus crystals (Jade, Amber, Amethyst, Sapphire, Topaz) for loot bundles."
          );
        } else {
          actions.push("Upgrade HOTM perks and push powder milestones.");
        }
        break;
      case "dungeons":
        actions.push("Review equipped gear's remaining essence and material costs, and check requirements before upgrading.");
        break;
      case "slayers":
        actions.push("Push lagging slayer tiers, especially Voidgloom and Blaze.");
        break;
      case "money":
        actions.push("Convert stockpiled collections or mining drops into liquid coins.");
        break;
      default:
        actions.push(gap.message);
    }
  }

  const mayorName = asString(getPath(mayor, ["active", "name"]));
  const perkNames = (asArray(getPath(mayor, ["active", "perks"])) ?? [])
    .map((perk) => asString(asRecord(perk)?.name)).filter((name): name is string => Boolean(name));
  if (mayorName && perkNames.length) {
    actions.push(`${mayorName} is mayor; plan around the reported active perks: ${perkNames.join(", ")}.`);
  }

  return [...new Set(actions)].slice(0, 6);
}
