import skillTables from "./skill-tables.json" with { type: "json" };

export type LevelProgress = {
  xp: number;
  level: number;
  xpInLevel: number;
  xpForNextLevel: number;
  maxLevel?: number;
};

type SkillTable = {
  maxLevel: number;
  totalExpRequired: number[];
};

const SKILL_TABLES = skillTables as Record<string, SkillTable>;

// Cumulative Garden XP required to reach each Garden level, indexed by level.
// The Garden has 15 levels (Garden I-XV); a freshly unlocked Garden is level 1
// at 0 XP, and Garden XV is reached at 60,120 XP. Derived from the NEU
// `garden_exp` per-level table (incremental: 70,70,140,240,600,1500,2000,2500,
// 3000, then 10000 x5). index 0 is unused so that level == array index.
// https://wiki.hypixel.net/Garden
const GARDEN_THRESHOLDS = [
  0, 0, 70, 140, 280, 520, 1120, 2620, 4620, 7120, 10120, 20120, 30120, 40120, 50120, 60120
];
const GARDEN_MAX_LEVEL = 15;

function normalizeSkillKey(skill: string): string {
  return skill.replace(/^skill_/, "").toLowerCase();
}

function thresholdsForSkill(skill: string): { thresholds: number[]; maxLevel: number } {
  const key = normalizeSkillKey(skill);
  const table = SKILL_TABLES[key] ?? SKILL_TABLES.farming;

  if (!table) {
    return { thresholds: [0], maxLevel: 0 };
  }

  return {
    thresholds: [0, ...table.totalExpRequired],
    maxLevel: table.maxLevel
  };
}

function levelFromThresholds(xp: number, thresholds: number[], maxLevel?: number): LevelProgress {
  let level = 0;

  for (let index = thresholds.length - 1; index >= 0; index--) {
    if (xp >= thresholds[index]!) {
      level = index;
      break;
    }
  }

  if (maxLevel !== undefined) {
    level = Math.min(level, maxLevel);
  }

  const currentThreshold = thresholds[level] ?? 0;
  const nextThreshold = thresholds[level + 1];
  const xpInLevel = xp - currentThreshold;
  const xpForNextLevel = nextThreshold !== undefined ? nextThreshold - currentThreshold : 0;

  return {
    xp,
    level,
    xpInLevel,
    xpForNextLevel,
    maxLevel
  };
}

export function skillLevelFromXp(xp: number, skill = "farming"): LevelProgress {
  const { thresholds, maxLevel } = thresholdsForSkill(skill);
  return levelFromThresholds(xp, thresholds, maxLevel);
}

export function catacombsLevelFromXp(xp: number): LevelProgress {
  // Catacombs and dungeon class levels share the NEU/Hypixel dungeoneering XP table.
  return skillLevelFromXp(xp, "catacombs");
}

export function gardenLevelFromXp(xp: number): LevelProgress {
  return levelFromThresholds(xp, GARDEN_THRESHOLDS, GARDEN_MAX_LEVEL);
}

export function skyblockLevelFromExperience(experience: number): LevelProgress {
  // SkyBlock level is a flat 100 SkyBlock XP per level.
  // https://wiki.hypixel.net/SkyBlock_Levels
  const safeXp = Math.max(0, experience);
  const level = Math.floor(safeXp / 100);

  return {
    xp: safeXp,
    level,
    xpInLevel: safeXp - level * 100,
    xpForNextLevel: 100
  };
}

// Per-level XP requirements shared across all pet rarities (NEU/SkyCrypt constant).
// A pet's rarity selects a starting offset into this array.
const PET_LEVELS = [
  100, 110, 120, 130, 145, 160, 175, 190, 210, 230, 250, 275, 300, 330, 360, 400, 440, 490, 540, 600, 660, 730, 800,
  880, 960, 1050, 1150, 1260, 1380, 1510, 1650, 1800, 1960, 2130, 2310, 2500, 2700, 2920, 3160, 3420, 3700, 4000, 4350,
  4750, 5200, 5700, 6300, 7000, 7800, 8700, 9700, 10800, 12000, 13300, 14700, 16200, 17800, 19500, 21300, 23200, 25200,
  27400, 29800, 32400, 35200, 38200, 41400, 44800, 48400, 52200, 56200, 60400, 64800, 69400, 74200, 79200, 84700, 90700,
  97200, 104200, 111700, 119700, 128200, 137200, 146700, 156700, 167700, 179700, 192700, 206700, 221700, 237700, 254700,
  272700, 291700, 311700, 333700, 357700, 383700, 411700, 441700, 476700, 516700, 561700, 611700, 666700, 726700,
  791700, 861700, 936700, 1016700, 1101700, 1191700, 1286700, 1386700, 1496700, 1616700, 1746700, 1886700
];

const PET_RARITY_OFFSET: Record<string, number> = {
  COMMON: 0,
  UNCOMMON: 6,
  RARE: 11,
  EPIC: 16,
  LEGENDARY: 20,
  MYTHIC: 20
};

// Dragon pets (Golden, Jade, Rose) level past 100, capping at 200.
const PET_MAX_LEVEL_OVERRIDES: Record<string, number> = {
  GOLDEN_DRAGON: 200,
  JADE_DRAGON: 200,
  ROSE_DRAGON: 200
};

// Dragon levels 100->200 follow a separate NEU curve (constants/pets.json
// custom_pet_leveling): step 100->101 costs 0, 101->102 costs 5,555, and every
// step after that costs the final tabulated increment (1,886,700). Index i is
// the cost of going from level (100 + i) to (101 + i).
const DRAGON_EXTRA_LEVELS = [0, 5_555, ...Array<number>(98).fill(1_886_700)];

export function petLevelFromExp(exp: number, tier = "COMMON", petType?: string): LevelProgress {
  const offset = PET_RARITY_OFFSET[tier.toUpperCase()] ?? 0;
  const maxLevel = petType ? PET_MAX_LEVEL_OVERRIDES[petType.toUpperCase()] ?? 100 : 100;
  const isDragon = maxLevel > 100;
  const safeExp = Math.max(0, exp);

  let level = 1;
  let remaining = safeExp;
  let required = stepCost(offset);

  while (level < maxLevel) {
    required =
      isDragon && level >= 100
        ? DRAGON_EXTRA_LEVELS[level - 100] ?? 1_886_700
        : stepCost(offset + level - 1);
    if (remaining < required) {
      break;
    }

    remaining -= required;
    level++;
  }

  return {
    xp: safeExp,
    level,
    xpInLevel: level >= maxLevel ? 0 : remaining,
    xpForNextLevel: level >= maxLevel ? 0 : required,
    maxLevel
  };
}

function stepCost(index: number): number {
  return PET_LEVELS[Math.min(index, PET_LEVELS.length - 1)] ?? PET_LEVELS[PET_LEVELS.length - 1]!;
}

export function slayerTierFromRecord(claimedLevels: Record<string, unknown> | undefined): number {
  if (!claimedLevels) {
    return 0;
  }

  let tier = 0;

  for (const [key, value] of Object.entries(claimedLevels)) {
    if (value !== true) {
      continue;
    }

    const match = key.match(/(\d+)/);
    if (!match) {
      continue;
    }

    tier = Math.max(tier, Number.parseInt(match[1]!, 10));
  }

  return tier;
}

export function summarizeSkillLevels(skills: Record<string, number>): Record<string, LevelProgress> {
  const result: Record<string, LevelProgress> = {};

  for (const [skill, xp] of Object.entries(skills)) {
    result[skill] = skillLevelFromXp(xp, skill);
  }

  return result;
}
