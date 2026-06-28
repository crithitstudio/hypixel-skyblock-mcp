import type { JsonObject } from "./types.js";
import { asNumber, asRecord, compactObject } from "./utils.js";

// Skills counted toward the SkyBlock "skill average". Social, Runecrafting,
// Carpentry, Dungeoneering, and Hunting are excluded by convention.
// https://wiki.hypixel.net/Skills
export const SKILL_AVERAGE_SKILLS = [
  "farming",
  "mining",
  "combat",
  "foraging",
  "fishing",
  "enchanting",
  "alchemy",
  "taming"
] as const;

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * Computes skill average from a map of skill -> level progress objects
 * (as produced by summarizeSkillLevels). Returns both the integer-level
 * average that players quote and a fractional "true" average.
 */
export function computeSkillAverage(skillLevels: Record<string, unknown> | undefined): JsonObject | undefined {
  if (!skillLevels) {
    return undefined;
  }

  const counted: string[] = [];
  let levelSum = 0;
  let trueSum = 0;

  for (const skill of SKILL_AVERAGE_SKILLS) {
    const entry = asRecord(skillLevels[skill]);
    const level = asNumber(entry?.level);
    if (entry === undefined || level === undefined) {
      continue;
    }

    counted.push(skill);
    levelSum += level;

    const xpInLevel = asNumber(entry.xpInLevel) ?? 0;
    const xpForNext = asNumber(entry.xpForNextLevel) ?? 0;
    const fraction = xpForNext > 0 ? Math.min(xpInLevel / xpForNext, 1) : 0;
    trueSum += level + fraction;
  }

  if (!counted.length) {
    return undefined;
  }

  return compactObject({
    skillAverage: round(levelSum / counted.length),
    trueSkillAverage: round(trueSum / counted.length),
    countedSkills: counted.length,
    missingSkills: SKILL_AVERAGE_SKILLS.filter((skill) => !counted.includes(skill))
  });
}

/**
 * Aggregates slayer progress into total XP and summed slayer levels.
 * Accepts the slayer summary shape from summarizeSlayers (xp + tier per boss).
 */
export function summarizeSlayerTotals(slayers: JsonObject | undefined): JsonObject | undefined {
  if (!slayers) {
    return undefined;
  }

  let totalXp = 0;
  let totalLevels = 0;
  const perBoss: JsonObject = {};

  for (const [boss, value] of Object.entries(slayers)) {
    const record = asRecord(value);
    if (!record) {
      continue;
    }

    const xp = asNumber(record.xp) ?? 0;
    const level = asNumber(record.tier) ?? 0;
    totalXp += xp;
    totalLevels += level;
    perBoss[boss] = compactObject({ xp, level });
  }

  if (!Object.keys(perBoss).length) {
    return undefined;
  }

  return compactObject({
    totalXp,
    totalSlayerLevels: totalLevels,
    perBoss
  });
}

/**
 * Builds a compact set of the headline numbers players compare: skill average,
 * total slayer XP/levels, catacombs level, magical power, and SkyBlock level.
 */
export function buildPlayerRatings(input: {
  skillLevels?: Record<string, unknown>;
  slayers?: JsonObject;
  catacombsLevel?: number;
  magicalPower?: number;
  skyblockLevel?: number;
}): JsonObject | undefined {
  const skillAverage = computeSkillAverage(input.skillLevels);
  const slayer = summarizeSlayerTotals(input.slayers);

  const ratings = compactObject({
    skyblockLevel: input.skyblockLevel,
    skillAverage: asNumber(skillAverage?.skillAverage),
    trueSkillAverage: asNumber(skillAverage?.trueSkillAverage),
    catacombsLevel: input.catacombsLevel,
    totalSlayerXp: asNumber(slayer?.totalXp),
    totalSlayerLevels: asNumber(slayer?.totalSlayerLevels),
    magicalPower: input.magicalPower,
    slayer
  });

  return Object.keys(ratings).length ? ratings : undefined;
}
