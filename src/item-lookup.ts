import type { HypixelClient } from "./hypixelClient.js";
import { buildPriceBook, priceFor } from "./pricing.js";
import type { PriceBasis } from "./pricing.js";
import { getBazaar } from "./skyblock.js";
import type { JsonObject } from "./types.js";
import { asArray, asNumber, asRecord, asString, compactObject, freshnessFromMeta, stripMinecraftFormatting } from "./utils.js";
import { ITEM_VALUE_CAVEATS } from "./caveats.js";
import { getOfficialWikiItemContext } from "./wiki.js";

export type ItemLookupOptions = {
  itemId?: string;
  search?: string;
  includeBazaarOrders?: boolean;
  priceBasis?: PriceBasis;
  maxCandidates?: number;
  includeWiki?: boolean;
  maxWikiSectionChars?: number;
};

type ResolvedItem = { id: string; record: JsonObject };

function cleanName(value: unknown): string | undefined {
  const name = asString(value);
  return name ? stripMinecraftFormatting(name) : undefined;
}

/**
 * Resolves an item by exact ID, then exact (case-insensitive) name, then
 * substring match. Returns a single item, a list of candidates when the match
 * is ambiguous, or nothing when there is no match — so callers never present an
 * arbitrary item as "the" answer.
 */
function resolveItem(
  items: JsonObject[],
  options: ItemLookupOptions
): { item?: ResolvedItem; candidates?: { id: string; name?: string }[] } {
  const indexed = items
    .map((record) => ({ id: asString(record.id), record }))
    .filter((entry): entry is ResolvedItem => Boolean(entry.id));

  if (options.itemId) {
    const wanted = options.itemId.toUpperCase();
    const exact = indexed.find((entry) => entry.id.toUpperCase() === wanted);
    if (exact) {
      return { item: exact };
    }
  }

  const query = (options.search ?? options.itemId ?? "").trim().toLowerCase();
  if (!query) {
    return {};
  }

  const exactName = indexed.filter((entry) => cleanName(entry.record.name)?.toLowerCase() === query);
  if (exactName.length === 1) {
    return { item: exactName[0] };
  }
  if (exactName.length > 1) {
    return { candidates: exactName.map((entry) => ({ id: entry.id, name: cleanName(entry.record.name) })) };
  }

  const limit = Math.max(1, Math.min(options.maxCandidates ?? 15, 50));
  const matches = indexed.filter(
    (entry) => entry.id.toLowerCase().includes(query) || cleanName(entry.record.name)?.toLowerCase().includes(query)
  );

  if (matches.length === 1) {
    return { item: matches[0] };
  }
  if (matches.length > 1) {
    return { candidates: matches.slice(0, limit).map((entry) => ({ id: entry.id, name: cleanName(entry.record.name) })) };
  }

  return {};
}

function summarizeIdentity(id: string, record: JsonObject): JsonObject {
  return compactObject({
    id,
    name: cleanName(record.name),
    tier: record.tier,
    category: record.category ?? record.category_display,
    material: record.material,
    npcSellPrice: asNumber(record.npc_sell_price),
    stats: record.stats,
    requirements: record.requirements,
    dungeonItem: record.dungeon_item,
    gemstoneSlots: Array.isArray(record.gemstone_slots) ? (record.gemstone_slots as unknown[]).length : undefined,
    museum: record.museum,
    soulbound: record.soulbound,
    color: record.color,
    unstackable: record.unstackable
  });
}

/**
 * One-call item profile: official metadata plus a live value. Bazaar items get
 * full buy/sell/spread/volume; non-Bazaar items are priced from the configured
 * lowest-BIN source when available, otherwise clearly flagged as auction-only
 * with no synthesized price.
 */
export async function lookupItem(client: HypixelClient, options: ItemLookupOptions): Promise<JsonObject> {
  if (!options.itemId && !options.search) {
    return { error: "Provide either itemId or search." };
  }

  const itemsResult = await client.hypixel<JsonObject>("/v2/resources/skyblock/items", undefined, { ttlMs: 10 * 60_000 });
  const items = (asArray(itemsResult.data.items) ?? [])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is JsonObject => Boolean(entry));

  const resolved = resolveItem(items, options);

  if (!resolved.item) {
    return compactObject({
      meta: itemsResult.meta,
      found: false,
      candidates: resolved.candidates,
      note: resolved.candidates?.length
        ? "Multiple items matched. Re-query with one of the candidate IDs via itemId."
        : "No item matched. Check the SkyBlock ID or try a broader search term."
    });
  }

  const { id, record } = resolved.item;

  const warnings: string[] = [];
  const bazaar = await getBazaar(client, {
    productIds: [id],
    includeOrders: Boolean(options.includeBazaarOrders),
    limit: 1
  }).catch(() => {
    warnings.push("Bazaar prices are unavailable; item metadata remains available.");
    return undefined;
  });
  const bazaarProduct = asArray(bazaar?.products)?.[0] as JsonObject | undefined;

  let value: JsonObject;
  let priceFreshness: unknown;
  let sourceStatus: unknown;
  if (bazaarProduct) {
    priceFreshness = bazaar?.freshness;
    sourceStatus = { bazaar: "available" };
    value = compactObject({
      source: "bazaar",
      buyPrice: bazaarProduct.buyPrice,
      sellPrice: bazaarProduct.sellPrice,
      spread: bazaarProduct.margin,
      spreadPercent: bazaarProduct.marginPercent,
      buyVolume: bazaarProduct.buyVolume,
      sellVolume: bazaarProduct.sellVolume,
      movingWeek: bazaarProduct.movingWeek,
      orders: options.includeBazaarOrders
        ? compactObject({ sellSummary: bazaarProduct.sellSummary, buySummary: bazaarProduct.buySummary })
        : undefined
    });
  } else {
    const basis: PriceBasis = options.priceBasis ?? "buy";
    const priceBook = await buildPriceBook(client, { basis, includeAuctionPrices: true });
    const lowbin = priceFor(priceBook, id);
    const source = priceBook.sourceByItem?.get(id.toUpperCase());
    sourceStatus = priceBook.sourceStatus;
    warnings.push(...(priceBook.warnings ?? []));
    if (lowbin !== undefined && source) {
      priceFreshness = priceBook.sourceFreshness?.[source];
      value = compactObject({
        source,
        price: lowbin,
        basis,
        note: source === "lowest_bin"
          ? "Price from the configured external lowest-BIN source (SKYBLOCK_LOWEST_BIN_URL)."
          : "Bazaar price became available on retry."
      });
    } else {
      value = {
        source: "none",
        note: priceBook.sourceStatus?.lowest_bin === "not_configured"
          ? "No live price is available and no lowest-BIN source is configured. Use skyblock_auctions for listings, or set SKYBLOCK_LOWEST_BIN_URL."
          : priceBook.sourceStatus?.lowest_bin === "unavailable"
            ? "The configured lowest-BIN source is unavailable. No live price can be established; try again or use skyblock_auctions."
            : "The item has no price in the available market sources. Use skyblock_auctions to check listings."
      };
    }
  }

  const item = summarizeIdentity(id, record);
  const wiki = options.includeWiki
    ? await getOfficialWikiItemContext(
        { id, name: asString(item.name) },
        { maxSectionChars: options.maxWikiSectionChars }
      ).catch((error) => ({
        source: "configured_mediawiki",
        official: false,
        error: error instanceof Error ? error.message : String(error)
      }))
    : undefined;

  return compactObject({
    meta: itemsResult.meta,
    freshness: freshnessFromMeta(
      itemsResult.meta,
      10 * 60,
      "This timestamp covers cached item metadata (tier/stats), not the price. See priceFreshness for how current the value is."
    ),
    priceFreshness,
    sourceStatus,
    warnings: [...new Set(warnings)],
    caveats: ITEM_VALUE_CAVEATS,
    found: true,
    item,
    value,
    wiki
  });
}
