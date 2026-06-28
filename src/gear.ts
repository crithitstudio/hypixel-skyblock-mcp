import type { DecodedInventory, DecodedInventoryItem, JsonObject } from "./types.js";
import { asNumber, asString, compactObject } from "./utils.js";

const MINING_ARMOR_IDS = ["DIVAN", "YOG", "GLACITE", "SORROW", "HEAT", "MINER", "MITHRIL", "EMERALD"];
const FARMING_ARMOR_IDS = ["RANCHER", "FARM", "MELON", "CROPIE", "SQUASH", "FERMENTO", "LANTERN"];
const DUNGEON_ARMOR_IDS = ["GOLDOR", "NECRON", "STORM", "MAXOR", "SHADOW_ASSASSIN", "ADAPTIVE", "MENDER", "WITHER"];
const RIFT_ARMOR_IDS = ["UGLY", "FEMURGROWTH", "ORANGE", "ANTI_BITE", "LIVING_METAL"];

type LoadoutSummary = {
  id: string;
  pieces: DecodedInventoryItem[];
  inferredSet?: string;
  averageStars?: number;
  reforge?: string;
  label?: string;
};

export function summarizeLoadouts(decodedInventories: DecodedInventory[] | undefined): JsonObject[] {
  if (!decodedInventories?.length) {
    return [];
  }

  const loadouts = new Map<string, LoadoutSummary>();

  for (const section of decodedInventories) {
    const match = section.path.match(/loadout\.armor\.(\d+)\./i);
    if (!match) {
      continue;
    }

    const id = match[1]!;
    const existing = loadouts.get(id) ?? { id, pieces: [] };
    existing.pieces.push(...section.items);
    loadouts.set(id, existing);
  }

  return [...loadouts.values()].map((loadout) => summarizeLoadout(loadout));
}

function summarizeLoadout(loadout: LoadoutSummary): JsonObject {
  const ids = loadout.pieces.map((piece) => asString(piece.skyblockId) ?? "").filter(Boolean);
  const stars = loadout.pieces.map((piece) => asNumber(piece.dungeonStars)).filter((value): value is number => value !== undefined);
  const reforges = [...new Set(loadout.pieces.map((piece) => asString(piece.reforge)).filter(Boolean))];
  const inferredSet = inferArmorSet(ids);
  const label = inferLoadoutLabel(ids, inferredSet);

  return compactObject({
    id: Number.parseInt(loadout.id, 10),
    label,
    inferredSet,
    pieceCount: loadout.pieces.length,
    averageStars: stars.length ? Math.round((stars.reduce((sum, value) => sum + value, 0) / stars.length) * 10) / 10 : undefined,
    reforge: reforges.length === 1 ? reforges[0] : reforges.join("/"),
    pieces: loadout.pieces.map((piece) =>
      compactObject({
        slot: piece.slot,
        skyblockId: piece.skyblockId,
        name: piece.name,
        rarity: piece.rarity,
        reforge: piece.reforge,
        dungeonStars: piece.dungeonStars
      })
    )
  });
}

function inferArmorSet(ids: string[]): string | undefined {
  const joined = ids.join(" ").toUpperCase();

  for (const token of ["GOLDOR", "NECRON", "STORM", "MAXOR", "SHADOW_ASSASSIN", "FERMENTO", "SQUASH", "CROPIE", "DIVAN", "YOG", "GLACITE", "MELON", "FARM"]) {
    if (joined.includes(token)) {
      return token.replace(/_/g, " ");
    }
  }

  return undefined;
}

function inferLoadoutLabel(ids: string[], inferredSet?: string): string | undefined {
  const joined = ids.join(" ").toUpperCase();

  if (joined.includes("TANK_WITHER") || joined.includes("MENDER")) {
    return "Tank";
  }

  if (joined.includes("SHADOW_ASSASSIN")) {
    return "DPS";
  }

  if (joined.includes("MELON") || joined.includes("FARM") || joined.includes("CROPIE") || joined.includes("LANTERN")) {
    return "Farming";
  }

  if (joined.includes("DIVAN") || joined.includes("YOG")) {
    return "Mining";
  }

  return inferredSet;
}

export function summarizeEquippedGear(decodedInventories: DecodedInventory[] | undefined): JsonObject | undefined {
  if (!decodedInventories?.length) {
    return undefined;
  }

  const armor = decodedInventories.find((section) => section.path === "inventory.inv_armor");
  const equipment = decodedInventories.find((section) => section.path === "inventory.equipment_contents");

  const armorIds = armor?.items.map((item) => asString(item.skyblockId) ?? "").join(" ") ?? "";
  const tool = findLikelyTool(decodedInventories);

  return compactObject({
    armorSet: inferArmorSet(armor?.items.map((item) => asString(item.skyblockId) ?? "") ?? []),
    armor: armor?.items.map(summarizeGearPiece),
    equipment: equipment?.items.map(summarizeGearPiece),
    tool: tool ? summarizeGearPiece(tool) : undefined,
    inferredRole: inferPrimaryRole(armorIds, tool?.skyblockId)
  });
}

function findLikelyTool(decodedInventories: DecodedInventory[]): DecodedInventoryItem | undefined {
  const inventory = decodedInventories.find((section) => section.path === "inventory.inv_contents");
  if (!inventory) {
    return undefined;
  }

  const toolIds = ["DRILL", "PICKAXE", "GAUNTLET", "HOE", "AXE"];

  return inventory.items.find((item) => {
    const id = asString(item.skyblockId)?.toUpperCase() ?? "";
    return toolIds.some((token) => id.includes(token));
  });
}

function summarizeGearPiece(item: DecodedInventoryItem): JsonObject {
  return compactObject({
    skyblockId: item.skyblockId,
    name: item.name,
    rarity: item.rarity,
    reforge: item.reforge,
    dungeonStars: item.dungeonStars
  });
}

export function inferPrimaryRole(armorIds: string, toolId?: string): string {
  const armor = armorIds.toUpperCase();
  const tool = (toolId ?? "").toUpperCase();

  if (tool.includes("DRILL") || tool.includes("GAUNTLET") || MINING_ARMOR_IDS.some((token) => armor.includes(token))) {
    return "mining";
  }

  if (FARMING_ARMOR_IDS.some((token) => armor.includes(token)) || tool.includes("HOE")) {
    return "farming";
  }

  if (DUNGEON_ARMOR_IDS.some((token) => armor.includes(token))) {
    return "dungeons";
  }

  if (RIFT_ARMOR_IDS.some((token) => armor.includes(token))) {
    return "rift";
  }

  return "general";
}

export function summarizeGearQuality(
  equipped: JsonObject | undefined,
  skills: Record<string, { level: number }> | undefined
): JsonObject | undefined {
  if (!equipped || !skills) {
    return undefined;
  }

  const role = asString(equipped.inferredRole) ?? "general";
  const armorSet = asString(equipped.armorSet);

  const ratings: JsonObject = {};

  if ((skills.mining?.level ?? 0) >= 40) {
    ratings.mining = rateMiningGear(armorSet, equipped.tool as JsonObject | undefined);
  }

  if ((skills.farming?.level ?? 0) >= 40) {
    ratings.farming = rateFarmingGear(armorSet);
  }

  if ((skills.combat?.level ?? 0) >= 40) {
    ratings.combat = rateCombatGear(armorSet, equipped.armor as JsonObject[] | undefined);
    ratings.dungeons = rateDungeonGear(armorSet, equipped.armor as JsonObject[] | undefined);
  }

  ratings.primaryRole = role;

  return ratings;
}

function rateMiningGear(armorSet: string | undefined, tool: JsonObject | undefined): string {
  const armor = (armorSet ?? "").toUpperCase();
  const toolId = asString(tool?.skyblockId)?.toUpperCase() ?? "";

  if (armor.includes("DIVAN") && (toolId.includes("DRILL") || toolId.includes("GAUNTLET"))) {
    return "strong";
  }

  if (armor.includes("YOG") || armor.includes("GLACITE")) {
    return "mid";
  }

  return "weak";
}

function rateFarmingGear(armorSet: string | undefined): string {
  const armor = (armorSet ?? "").toUpperCase();

  if (armor.includes("FERMENTO") || armor.includes("SQUASH")) {
    return "strong";
  }

  if (armor.includes("CROPIE")) {
    return "mid";
  }

  if (armor.includes("MELON") || armor.includes("FARM")) {
    return "weak";
  }

  return "weak";
}

function rateCombatGear(armorSet: string | undefined, armor: JsonObject[] | undefined): string {
  return rateDungeonGear(armorSet, armor);
}

function rateDungeonGear(armorSet: string | undefined, armor: JsonObject[] | undefined): string {
  const set = (armorSet ?? "").toUpperCase();

  if (set.includes("NECRON") || set.includes("STORM") || set.includes("GOLDOR") || set.includes("MAXOR")) {
    const stars = (armor ?? [])
      .map((piece) => asNumber(piece.dungeonStars))
      .filter((value): value is number => value !== undefined);
    const average = stars.length ? stars.reduce((sum, value) => sum + value, 0) / stars.length : 0;
    return average >= 5 ? "strong" : "mid";
  }

  if (set.includes("SHADOW")) {
    return "mid";
  }

  return "weak";
}
