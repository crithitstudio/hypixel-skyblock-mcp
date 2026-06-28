import * as nbt from "prismarine-nbt";
import type { DecodedInventory, DecodedInventoryItem, JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, isRecord, stripMinecraftFormatting } from "./utils.js";

export type InventoryDecodeOptions = {
  includeItemDetails?: boolean;
  includeRawNbt?: boolean;
  maxLoreLines?: number;
};

export type InventorySectionQuery = InventoryDecodeOptions & {
  maxSections?: number;
  maxItemsPerSection?: number;
  sectionTypes?: string[];
  sectionPaths?: string[];
  includeAllNbtData?: boolean;
};

export type NbtDataLocation = {
  path: string;
  data: string;
  sectionType: string;
};

export async function decodeBase64Nbt(data: string): Promise<unknown> {
  const buffer = Buffer.from(data, "base64");
  const { parsed } = await nbt.parse(buffer);
  return nbt.simplify(parsed) as unknown;
}

export async function decodeInventoryData(
  path: string,
  data: string,
  maxItems: number,
  options?: InventoryDecodeOptions
): Promise<DecodedInventory> {
  const sectionType = classifyInventoryPath(path);

  try {
    const simplified = await decodeBase64Nbt(data);
    const items = extractInventoryItems(simplified, options);
    const shown = items.slice(0, maxItems);

    return {
      path,
      sectionType,
      itemCount: items.length,
      shownItems: shown.length,
      items: shown,
      truncated: shown.length < items.length,
      raw: options?.includeRawNbt ? simplified : undefined
    };
  } catch (error) {
    return {
      path,
      sectionType,
      itemCount: 0,
      shownItems: 0,
      items: [],
      truncated: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function decodeInventoriesFromMember(
  member: unknown,
  options?: InventorySectionQuery
): Promise<DecodedInventory[]> {
  const maxSections = options?.maxSections ?? 24;
  const maxItemsPerSection = options?.maxItemsPerSection ?? 60;
  const locations = filterNbtDataLocations(findNbtDataLocations(member, [], options), options).slice(0, maxSections);
  const decoded: DecodedInventory[] = [];

  for (const location of locations) {
    decoded.push(await decodeInventoryData(location.path, location.data, maxItemsPerSection, options));
  }

  return decoded;
}

export function extractInventoryItems(simplifiedNbt: unknown, options?: InventoryDecodeOptions): DecodedInventoryItem[] {
  const candidate =
    asArray(asRecord(simplifiedNbt)?.i) ??
    asArray(asRecord(asRecord(simplifiedNbt)?.value)?.i) ??
    asArray(simplifiedNbt);

  if (!candidate) {
    return [];
  }

  return candidate
    .map((item, index) => summarizeNbtItem(item, index, options))
    .filter((item): item is DecodedInventoryItem => Boolean(item));
}

export function findNbtDataLocations(
  value: unknown,
  path: string[] = [],
  options?: { includeAllNbtData?: boolean }
): NbtDataLocation[] {
  if (!isRecord(value)) {
    return [];
  }

  const currentData = asString(value.data);
  const currentPath = path.join(".");
  const locations: NbtDataLocation[] = [];

  if (
    currentData &&
    looksLikeBase64Nbt(currentData) &&
    (options?.includeAllNbtData || isLikelyInventoryPath(currentPath))
  ) {
    locations.push({
      path: currentPath || "root",
      data: currentData,
      sectionType: classifyInventoryPath(currentPath)
    });
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "data") {
      continue;
    }

    if (isRecord(child)) {
      locations.push(...findNbtDataLocations(child, [...path, key], options));
    }
  }

  return dedupeLocations(locations);
}

export function filterNbtDataLocations(
  locations: NbtDataLocation[],
  options?: { sectionTypes?: string[]; sectionPaths?: string[] }
): NbtDataLocation[] {
  const requestedTypes = normalizeFilterSet(options?.sectionTypes);
  const requestedPaths = normalizeFilterSet(options?.sectionPaths);

  return locations.filter((location) => {
    if (requestedTypes && !requestedTypes.has(location.sectionType.toLowerCase())) {
      return false;
    }

    if (requestedPaths && ![...requestedPaths].some((path) => location.path.toLowerCase().includes(path))) {
      return false;
    }

    return true;
  });
}

export function classifyInventoryPath(path: string): string {
  const normalized = path.toLowerCase();

  if (normalized.includes("loadout")) return "loadout";
  if (normalized.includes("wardrobe")) return "wardrobe";
  if (normalized.includes("equipment")) return "equipment";
  if (normalized.includes("armor") || normalized.includes("armour")) return "armor";
  if (normalized.includes("ender")) return "ender_chest";
  if (normalized.includes("vault")) return "personal_vault";
  if (normalized.includes("talisman") || normalized.includes("accessory")) return "accessory_bag";
  if (normalized.includes("potion")) return "potion_bag";
  if (normalized.includes("fishing_bag") || normalized.includes("fishing")) return "fishing_bag";
  if (normalized.includes("quiver")) return "quiver";
  if (normalized.includes("backpack") || normalized.includes("storage")) return "backpack";
  if (normalized.includes("sack")) return "sack";
  if (normalized.includes("inv_armor")) return "armor";
  if (normalized.includes("inv_contents") || normalized.includes("inventory")) return "inventory";
  if (normalized.includes("contents") || normalized.includes("bag")) return "container";
  return "unknown";
}

function summarizeNbtItem(item: unknown, fallbackSlot: number, options?: InventoryDecodeOptions): DecodedInventoryItem | undefined {
  const record = asRecord(item);
  if (!record) {
    return undefined;
  }

  const id = asString(record.id);
  const count = asNumber(record.Count) ?? asNumber(record.count);
  const tag = asRecord(record.tag);
  const display = asRecord(tag?.display);
  const extra = asRecord(tag?.ExtraAttributes);
  const skyblockId = asString(extra?.id);
  const name = asString(display?.Name) ? stripMinecraftFormatting(asString(display?.Name)!) : undefined;
  const lore = asArray(display?.Lore)
    ?.map((line) => (typeof line === "string" ? stripMinecraftFormatting(line) : undefined))
    .filter((line): line is string => Boolean(line));
  const rarity = lore ? findRarity(lore) : undefined;
  const enchantments = normalizeNumberMap(asRecord(extra?.enchantments));
  const attributes = normalizeNumberMap(asRecord(extra?.attributes));
  const gems = asRecord(extra?.gems);

  if (!id && !skyblockId && !name) {
    return undefined;
  }

  return {
    slot: asNumber(record.Slot) ?? asNumber(record.slot) ?? fallbackSlot,
    skyblockId,
    minecraftId: id,
    name,
    count,
    rarity,
    reforge: asString(extra?.modifier),
    enchantments,
    attributes,
    gems,
    hotPotatoCount: asNumber(extra?.hot_potato_count),
    rarityUpgrades: asNumber(extra?.rarity_upgrades),
    dungeonStars: Math.max(asNumber(extra?.upgrade_level) ?? 0, asNumber(extra?.dungeon_item_level) ?? 0) || undefined,
    itemUuid: asString(extra?.uuid),
    timestamp: asString(extra?.timestamp),
    extraAttributes: options?.includeItemDetails ? summarizeExtraAttributes(extra) : undefined,
    lore: lore?.slice(0, options?.maxLoreLines ?? 8)
  };
}

function normalizeNumberMap(value: JsonObject | undefined): Record<string, number> | undefined {
  if (!value) {
    return undefined;
  }

  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "number") {
      result[key] = raw;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function findRarity(lore: string[]): string | undefined {
  const rarityLine = [...lore].reverse().find((line) =>
    /\b(COMMON|UNCOMMON|RARE|EPIC|LEGENDARY|MYTHIC|DIVINE|SPECIAL|VERY SPECIAL)\b/.test(line)
  );

  return rarityLine?.replace(/\s+(DUNGEON|SWORD|BOW|HELMET|CHESTPLATE|LEGGINGS|BOOTS|ACCESSORY|ITEM).*$/i, "").trim();
}

function isLikelyInventoryPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    normalized.includes("inventory") ||
    normalized.includes("contents") ||
    normalized.includes("loadout") ||
    normalized.includes("wardrobe") ||
    normalized.includes("backpack") ||
    normalized.includes("storage") ||
    normalized.includes("equipment") ||
    normalized.includes("armor") ||
    normalized.includes("vault") ||
    normalized.includes("ender") ||
    normalized.includes("sack") ||
    normalized.includes("bag")
  );
}

function looksLikeBase64Nbt(value: string): boolean {
  return value.length > 32 && /^[A-Za-z0-9+/=]+$/.test(value);
}

function normalizeFilterSet(values: string[] | undefined): Set<string> | undefined {
  const normalized = values?.map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!normalized?.length || normalized.includes("all")) {
    return undefined;
  }

  return new Set(normalized);
}

function dedupeLocations(locations: NbtDataLocation[]): NbtDataLocation[] {
  const seen = new Set<string>();
  const deduped: NbtDataLocation[] = [];

  for (const location of locations) {
    if (seen.has(location.path)) {
      continue;
    }

    seen.add(location.path);
    deduped.push(location);
  }

  return deduped;
}

function summarizeExtraAttributes(extra: JsonObject | undefined): JsonObject | undefined {
  if (!extra) {
    return undefined;
  }

  const omitted = new Set([
    "id",
    "modifier",
    "enchantments",
    "attributes",
    "gems",
    "hot_potato_count",
    "rarity_upgrades",
    "upgrade_level",
    "uuid",
    "timestamp"
  ]);
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(extra).slice(0, 80)) {
    if (omitted.has(key)) {
      continue;
    }

    const compact = compactExtraAttributeValue(value);
    if (compact !== undefined) {
      result[key] = compact;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function compactExtraAttributeValue(value: unknown): unknown {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    const compact = value.slice(0, 20).map(compactExtraAttributeValue).filter((entry) => entry !== undefined);
    return compact.length > 0 ? compact : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const entries = Object.entries(record).slice(0, 40);
  const compact = Object.fromEntries(
    entries
      .map(([key, child]) => [key, compactExtraAttributeValue(child)] as const)
      .filter(([, child]) => child !== undefined)
  );

  return Object.keys(compact).length > 0 ? compact : undefined;
}
