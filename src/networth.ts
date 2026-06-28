import type { HypixelClient } from "./hypixelClient.js";
import { valueItemModifiers } from "./item-modifiers.js";
import type { ItemMeta } from "./item-modifiers.js";
import { decodeInventoriesFromMember } from "./nbt.js";
import type { InventorySectionQuery } from "./nbt.js";
import { buildPriceBook, priceFor } from "./pricing.js";
import type { PriceBasis, PriceBook } from "./pricing.js";
import { loadProfileMember, summarizeProfile } from "./skyblock.js";
import { extractSacksCounts } from "./storage.js";
import type { DecodedInventory, JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, compactObject, getPath } from "./utils.js";

// Holdings worth pricing. "loadout" is excluded to avoid double counting saved
// wardrobe sets, and "sack" is handled separately via sacks_counts.
const NETWORTH_SECTION_TYPES = [
  "inventory",
  "ender_chest",
  "backpack",
  "personal_vault",
  "accessory_bag",
  "potion_bag",
  "fishing_bag",
  "quiver",
  "wardrobe",
  "armor",
  "equipment",
  "container"
];

const DISCLAIMER =
  "Estimate. Base item value is the SkyBlock-ID market price; on top of that, modifier value is added for " +
  "enchantments, hot potato/fuming books, recombobulators, and essence/master stars, valued at SkyHelper-Networth " +
  "'application worth' fractions of live Bazaar prices. Reforges, gemstones, and pet levels are still excluded. " +
  "Modifier value is only added to items that have a base price, so auction-only gear (no Bazaar base price) is " +
  "still undervalued unless an external lowest-BIN source (SKYBLOCK_LOWEST_BIN_URL) is configured.";

export type NetworthOptions = {
  username?: string;
  uuid?: string;
  profileId?: string;
  profileName?: string;
  selectedOnly?: boolean;
  memberUsername?: string;
  memberUuid?: string;
  priceBasis?: PriceBasis;
  includeAuctionPrices?: boolean;
  includeSacks?: boolean;
  topItems?: number;
  includeUnpriced?: boolean;
  includeModifiers?: boolean;
};

type ItemValue = {
  skyblockId: string;
  name?: string;
  count: number;
  unitPrice: number;
  value: number;
  modifierValue?: number;
};

export async function getSkyblockNetworth(client: HypixelClient, options: NetworthOptions): Promise<JsonObject> {
  const { player, profileResult, profile, memberUuid, member } = await loadProfileMember(client, options);

  if (!member) {
    return compactObject({
      meta: { profileSource: profileResult.meta, requestedPlayer: player, selectedMemberUuid: memberUuid },
      profile: summarizeProfile(profile),
      error: "No member data available for the selected profile (likely private API settings).",
      privacy: ["Member data is missing or private; networth cannot be estimated."]
    });
  }

  const priceBook = await buildPriceBook(client, {
    basis: options.priceBasis,
    includeAuctionPrices: options.includeAuctionPrices
  });

  const query: InventorySectionQuery = {
    maxSections: 200,
    maxItemsPerSection: 500,
    sectionTypes: NETWORTH_SECTION_TYPES,
    includeItemDetails: false,
    maxLoreLines: 0
  };
  const decoded = await decodeInventoriesFromMember(member, query);

  const includeModifiers = options.includeModifiers !== false;
  const itemMetaMap = includeModifiers ? await buildItemMetaMap(client) : undefined;

  const itemIndex = new Map<string, ItemValue>();
  const sectionValues: Record<string, number> = {};
  const modifierBreakdown: Record<string, number> = {};
  let modifiersTotal = 0;
  let modifierUnpriced = 0;
  let pricedStacks = 0;
  let totalStacks = 0;
  const unpriced = new Map<string, { skyblockId: string; name?: string; count: number }>();

  for (const section of decoded as DecodedInventory[]) {
    const sectionType = section.sectionType ?? "unknown";
    for (const item of section.items) {
      const skyblockId = item.skyblockId;
      if (!skyblockId) {
        continue;
      }

      totalStacks += 1;
      const count = item.count ?? 1;
      const unitPrice = priceFor(priceBook, skyblockId);

      if (unitPrice === undefined) {
        const key = skyblockId.toUpperCase();
        const existing = unpriced.get(key);
        if (existing) {
          existing.count += count;
        } else {
          unpriced.set(key, { skyblockId, name: item.name, count });
        }
        continue;
      }

      pricedStacks += 1;
      const key = skyblockId.toUpperCase();

      let modifierValue = 0;
      if (includeModifiers) {
        const mod = valueItemModifiers(item, priceBook, itemMetaMap?.get(key));
        modifierValue = mod.total;
        modifiersTotal += mod.total;
        modifierUnpriced += mod.unpriced;
        for (const [type, amount] of Object.entries(mod.breakdown)) {
          modifierBreakdown[type] = (modifierBreakdown[type] ?? 0) + amount;
        }
      }

      const value = unitPrice * count + modifierValue;
      sectionValues[sectionType] = (sectionValues[sectionType] ?? 0) + value;

      const existing = itemIndex.get(key);
      if (existing) {
        existing.count += count;
        existing.value += value;
        existing.modifierValue = (existing.modifierValue ?? 0) + modifierValue;
      } else {
        itemIndex.set(key, { skyblockId, name: item.name, count, unitPrice, value, modifierValue: modifierValue || undefined });
      }
    }
  }

  const itemsValue = Object.values(sectionValues).reduce((sum, value) => sum + value, 0);
  const sacks = options.includeSacks === false ? undefined : valueSacks(member, priceBook);
  const purse = asNumber(getPath(member, ["currencies", "coin_purse"])) ?? asNumber(member.coin_purse);
  const bank = asNumber(getPath(profile, ["banking", "balance"]));
  const liquid = (purse ?? 0) + (bank ?? 0);

  const total = liquid + itemsValue + (asNumber(sacks?.total) ?? 0);
  const topItemCount = Math.max(1, Math.min(options.topItems ?? 20, 100));
  const topItems = [...itemIndex.values()]
    .sort((left, right) => right.value - left.value)
    .slice(0, topItemCount)
    .map((entry) => compactObject({ ...entry, value: round(entry.value), unitPrice: round(entry.unitPrice) }));

  return compactObject({
    meta: {
      profileSource: profileResult.meta,
      requestedPlayer: player,
      selectedMemberUuid: memberUuid,
      hasApiKey: client.hasApiKey()
    },
    profile: summarizeProfile(profile),
    networth: compactObject({
      total: round(total),
      priceBasis: priceBook.basis,
      priceSources: priceBook.sources,
      liquid: compactObject({ purse: round(purse), bank: round(bank), total: round(liquid) }),
      items: compactObject({
        total: round(itemsValue),
        bySection: Object.fromEntries(Object.entries(sectionValues).map(([type, value]) => [type, round(value)])),
        modifiers: includeModifiers
          ? compactObject({
              total: round(modifiersTotal),
              byType: Object.fromEntries(Object.entries(modifierBreakdown).map(([type, value]) => [type, round(value)])),
              unpricedComponents: modifierUnpriced || undefined
            })
          : undefined,
        topItems
      }),
      sacks,
      coverage: compactObject({
        pricedItemStacks: pricedStacks,
        totalItemStacks: totalStacks,
        unpricedItemStacks: totalStacks - pricedStacks,
        pricedPercent: totalStacks > 0 ? round((pricedStacks / totalStacks) * 100, 1) : undefined
      }),
      unpricedItems: options.includeUnpriced
        ? [...unpriced.values()].sort((left, right) => right.count - left.count).slice(0, 50)
        : undefined,
      disclaimer: DISCLAIMER
    })
  });
}

// Builds a SkyBlock-ID -> {category, upgradeCosts} map from the official items
// resource, used to value essence/master stars and gate recombobulator credit.
// Failures are non-fatal: networth still prices base values and other modifiers.
async function buildItemMetaMap(client: HypixelClient): Promise<Map<string, ItemMeta>> {
  const map = new Map<string, ItemMeta>();
  try {
    const result = await client.hypixel<JsonObject>("/v2/resources/skyblock/items", undefined, { ttlMs: 10 * 60_000 });
    for (const entry of asArray(result.data.items) ?? []) {
      const record = asRecord(entry);
      const id = typeof record?.id === "string" ? record.id.toUpperCase() : undefined;
      if (!id) {
        continue;
      }

      map.set(id, {
        category: typeof record!.category === "string" ? (record!.category as string) : undefined,
        upgradeCosts: Array.isArray(record!.upgrade_costs) ? (record!.upgrade_costs as ItemMeta["upgradeCosts"]) : undefined
      });
    }
  } catch {
    // Item metadata is optional; modifier valuation degrades gracefully without it.
  }

  return map;
}

function valueSacks(member: JsonObject, priceBook: PriceBook): JsonObject | undefined {
  const counts = extractSacksCounts(member);
  if (!counts) {
    return undefined;
  }

  let total = 0;
  let pricedKinds = 0;
  const valued: ItemValue[] = [];

  for (const [id, rawCount] of Object.entries(counts)) {
    const count = asNumber(rawCount) ?? 0;
    if (count <= 0) {
      continue;
    }

    const unitPrice = priceFor(priceBook, id);
    if (unitPrice === undefined) {
      continue;
    }

    pricedKinds += 1;
    const value = unitPrice * count;
    total += value;
    valued.push({ skyblockId: id, count, unitPrice, value });
  }

  if (!valued.length) {
    return undefined;
  }

  return compactObject({
    total: round(total),
    pricedKinds,
    topValued: valued
      .sort((left, right) => right.value - left.value)
      .slice(0, 15)
      .map((entry) => compactObject({ skyblockId: entry.skyblockId, count: entry.count, value: round(entry.value) }))
  });
}

function round(value: number | undefined, digits = 0): number | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }

  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
