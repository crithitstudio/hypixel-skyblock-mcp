import type { DecodedInventory, DecodedInventoryItem, JsonObject } from "./types.js";
import { asNumber, asRecord, asString, compactObject } from "./utils.js";

export const DEFAULT_STORAGE_SECTION_TYPES = [
  "inventory",
  "ender_chest",
  "backpack",
  "personal_vault",
  "sack",
  "accessory_bag",
  "potion_bag",
  "wardrobe",
  "container"
] as const;

export type StorageAggregateOptions = {
  search?: string;
  skyblockIds?: string[];
  sectionTypes?: string[];
  limit?: number;
  groupBySkyblockId?: boolean;
};

export type StoredItemRef = {
  skyblockId?: string;
  name?: string;
  count?: number;
  rarity?: string;
  dungeonStars?: number;
  locations: Array<{ path: string; sectionType?: string; slot?: number }>;
};

export function aggregateStorageSections(
  decodedInventories: DecodedInventory[] | undefined,
  sacksCounts: JsonObject | undefined,
  options?: StorageAggregateOptions
): JsonObject {
  const allowedTypes = options?.sectionTypes?.map((value) => value.toLowerCase());
  const search = options?.search?.toLowerCase();
  const idFilter = new Set(options?.skyblockIds?.map((value) => value.toUpperCase()));
  const limit = options?.limit ?? 200;
  const groupBySkyblockId = options?.groupBySkyblockId ?? true;

  const sectionCounts: Record<string, number> = {};
  const itemIndex = new Map<string, StoredItemRef>();
  let totalItemStacks = 0;

  for (const section of decodedInventories ?? []) {
    const sectionType = section.sectionType ?? "unknown";
    if (allowedTypes?.length && !allowedTypes.includes(sectionType.toLowerCase())) {
      continue;
    }

    sectionCounts[sectionType] = (sectionCounts[sectionType] ?? 0) + 1;

    for (const item of section.items) {
      if (!matchesStorageFilter(item, search, idFilter)) {
        continue;
      }

      totalItemStacks += 1;
      const key = groupBySkyblockId
        ? (item.skyblockId ?? item.minecraftId ?? item.name ?? `slot:${section.path}:${item.slot}`).toUpperCase()
        : `${section.path}:${item.slot}:${item.skyblockId ?? item.name ?? "unknown"}`;

      const existing = itemIndex.get(key);
      const location = {
        path: section.path,
        sectionType: section.sectionType,
        slot: item.slot
      };

      if (existing) {
        existing.count = (existing.count ?? 0) + (item.count ?? 1);
        if (existing.locations.length < 8) {
          existing.locations.push(location);
        }
        continue;
      }

      itemIndex.set(key, {
        skyblockId: item.skyblockId,
        name: item.name,
        count: item.count ?? 1,
        rarity: item.rarity,
        dungeonStars: item.dungeonStars,
        locations: [location]
      });
    }
  }

  const sacks = summarizeSackCounts(sacksCounts);
  const items = [...itemIndex.values()]
    .sort((left, right) => (right.count ?? 0) - (left.count ?? 0) || (left.name ?? "").localeCompare(right.name ?? ""))
    .slice(0, limit);

  return compactObject({
    sectionsScanned: decodedInventories?.length ?? 0,
    sectionCounts,
    totalItemStacks,
    uniqueItems: itemIndex.size,
    sacks,
    items,
    truncated: itemIndex.size > items.length
  });
}

function matchesStorageFilter(item: DecodedInventoryItem, search: string | undefined, idFilter: Set<string>): boolean {
  if (idFilter.size > 0) {
    const skyblockId = item.skyblockId?.toUpperCase();
    if (!skyblockId || !idFilter.has(skyblockId)) {
      return false;
    }
  }

  if (!search) {
    return true;
  }

  const haystack = [item.skyblockId, item.name, item.minecraftId].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(search);
}

function summarizeSackCounts(sacksCounts: JsonObject | undefined): JsonObject | undefined {
  if (!sacksCounts) {
    return undefined;
  }

  const entries = Object.entries(sacksCounts)
    .map(([key, value]) => ({ id: key, count: asNumber(value) ?? 0 }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);

  if (!entries.length) {
    return undefined;
  }

  return compactObject({
    kinds: entries.length,
    totalItems: entries.reduce((sum, entry) => sum + entry.count, 0),
    top: Object.fromEntries(entries.slice(0, 25).map((entry) => [entry.id, entry.count]))
  });
}

export function extractSacksCounts(member: JsonObject | undefined): JsonObject | undefined {
  const inventory = asRecord(member?.inventory);
  const counts = asRecord(inventory?.sacks_counts);
  return counts ?? undefined;
}
