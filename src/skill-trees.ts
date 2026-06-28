import type { JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject, getPath } from "./utils.js";

export type SkillTreePerk = {
  id: string;
  name: string;
  level: number;
};

const HOTM_PERK_NAMES: Record<string, string> = {
  core_of_the_mountain: "Core of the Mountain",
  mining_speed: "Mining Speed",
  mining_fortune: "Mining Fortune",
  efficient_miner: "Efficient Miner",
  mole: "Mole",
  gemstone_infusion: "Gemstone Infusion",
  crystallized: "Crystallized",
  daily_powder: "Daily Powder",
  great_explorer: "Great Explorer",
  mining_madness: "Mining Madness",
  professional: "Professional",
  star_powder: "Star Powder",
  daily_effect: "Daily Effect",
  lucky_pickaxe: "Lucky Pickaxe",
  forge_time: "Forge Time",
  pickobulus: "Pickobulus",
  maniac_miner: "Maniac Miner",
  mining_experience: "Mining Experience",
  front_loaded: "Front Loaded",
  subzero_mining: "Subzero Mining"
};

const HOTF_PERK_NAMES: Record<string, string> = {
  sweep: "Sweep",
  foraging_fortune: "Foraging Fortune",
  daily_wishes: "Daily Wishes",
  axe_toss: "Axe Toss",
  speed_boost: "Speed Boost",
  treecapitator: "Treecapitator",
  strong_arms: "Strong Arms",
  forest_essence: "Forest Essence",
  galateas_might: "Galatea's Might"
};

// Only these five crystals can be placed in the Crystal Nucleus for loot bundles.
// Ruby, Jasper, and Glacite mineshaft crystals are forge-only.
export const NUCLEUS_CRYSTAL_KEYS = [
  "jade_crystal",
  "amber_crystal",
  "amethyst_crystal",
  "sapphire_crystal",
  "topaz_crystal"
] as const;

const NUCLEUS_CRYSTAL_KEY_SET = new Set<string>(NUCLEUS_CRYSTAL_KEYS);

export function isNucleusCrystal(crystalKey: string): boolean {
  return NUCLEUS_CRYSTAL_KEY_SET.has(crystalKey.toLowerCase());
}

export function countUnplacedNucleusCrystals(crystals: JsonObject | undefined): number {
  if (!crystals) {
    return 0;
  }

  return Object.entries(crystals).filter(([name, value]) => {
    if (!isNucleusCrystal(name)) {
      return false;
    }

    const record = asRecord(value);
    return record?.state === "FOUND";
  }).length;
}

export function formatPerkName(id: string, tree: "mining" | "foraging" = "mining"): string {
  const map = tree === "foraging" ? HOTF_PERK_NAMES : HOTM_PERK_NAMES;
  if (map[id]) {
    return map[id];
  }

  return id
    .replace(/^toggle_/, "")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function extractTreePerks(nodes: JsonObject | undefined, tree: "mining" | "foraging"): SkillTreePerk[] {
  if (!nodes) {
    return [];
  }

  return Object.entries(nodes)
    .filter(([key, value]) => !key.startsWith("toggle_") && typeof value === "number" && value > 0)
    .map(([key, value]) => ({
      id: key,
      name: formatPerkName(key, tree),
      level: value as number
    }))
    .sort((left, right) => right.level - left.level || left.name.localeCompare(right.name));
}

export function summarizeHotmTree(skillTree: JsonObject | undefined, miningCore: JsonObject | undefined): JsonObject | undefined {
  const miningNodes = asRecord(asRecord(skillTree?.nodes)?.mining);
  if (!miningCore && !miningNodes) {
    return undefined;
  }

  const perks = extractTreePerks(miningNodes, "mining");
  const unlockedPerks = perks.length;
  const hotmLevel = asNumber(miningNodes?.core_of_the_mountain);

  return compactObject({
    level: hotmLevel,
    unlockedPerks,
    selectedAbility: asString(getPath(skillTree, ["selected_ability", "mining"])),
    perks,
    powder: compactObject({
      mithril: asNumber(miningCore?.powder_mithril),
      mithrilTotal: asNumber(miningCore?.powder_mithril_total),
      mithrilSpent: asNumber(miningCore?.powder_spent_mithril),
      gemstone: asNumber(miningCore?.powder_gemstone),
      gemstoneTotal: asNumber(miningCore?.powder_gemstone_total),
      gemstoneSpent: asNumber(miningCore?.powder_spent_gemstone),
      glacite: asNumber(miningCore?.powder_glacite),
      glaciteTotal: asNumber(miningCore?.powder_glacite_total),
      glaciteSpent: asNumber(miningCore?.powder_spent_glacite)
    }),
    crystals: summarizeCrystalStates(asRecord(miningCore?.crystals)),
    biomes: asRecord(miningCore?.biomes),
    tokensSpent: asNumber(asRecord(skillTree)?.tokens_spent)
  });
}

export function summarizeHotfTree(skillTree: JsonObject | undefined, foragingCore: JsonObject | undefined): JsonObject | undefined {
  const foragingNodes = asRecord(asRecord(skillTree?.nodes)?.foraging);
  if (!foragingCore && !foragingNodes) {
    return undefined;
  }

  const perks = extractTreePerks(foragingNodes, "foraging");

  return compactObject({
    unlockedPerks: perks.length,
    selectedAbility: asString(getPath(skillTree, ["selected_ability", "foraging"])),
    perks,
    whispers: compactObject({
      current: asNumber(foragingCore?.forests_whispers),
      spent: asNumber(foragingCore?.forests_whispers_spent)
    }),
    dailyTreesCut: asNumber(foragingCore?.daily_trees_cut),
    dailyLogCut: asArray(foragingCore?.daily_log_cut)
  });
}

function summarizeCrystalStates(crystals: JsonObject | undefined): JsonObject | undefined {
  if (!crystals) {
    return undefined;
  }

  const result: JsonObject = {};

  for (const [name, value] of Object.entries(crystals)) {
    const record = asRecord(value);
    if (!record) {
      continue;
    }

    result[name] = compactObject({
      state: record.state,
      totalFound: asNumber(record.total_found),
      totalPlaced: asNumber(record.total_placed)
    });
  }

  return result;
}
