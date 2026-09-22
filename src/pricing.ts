import type { HypixelClient } from "./hypixelClient.js";
import type { JsonObject } from "./types.js";
import { asNumber, asRecord, freshnessFromTimestamp, parseEnvInteger } from "./utils.js";

export type PriceBasis = "buy" | "sell";
type PriceSource = "bazaar" | "lowest_bin";
type SourceStatus = "available" | "unavailable" | "not_configured" | "disabled";

export type PriceFreshness = {
  retrievedAt?: string;
  sourceUpdatedAt?: string;
  cached: boolean;
  dataAgeSeconds: number | null;
  staleWarning?: string;
  note?: string;
};

export type PriceBook = {
  prices: Map<string, number>;
  basis: PriceBasis;
  sources: string[];
  /** Upstream Bazaar snapshot time (ISO), not HTTP retrieval time. */
  pricedAt?: string;
  /** Whether the backing Bazaar response was served from cache. */
  pricedFromCache?: boolean;
  sourceByItem?: Map<string, PriceSource>;
  sourceStatus?: Record<PriceSource, SourceStatus>;
  sourceFreshness?: Partial<Record<PriceSource, PriceFreshness>>;
  warnings?: string[];
};

export type PriceBookOptions = {
  basis?: PriceBasis;
  includeAuctionPrices?: boolean;
};

/**
 * Builds a SkyBlock-ID -> unit-price lookup. Bazaar prices are always loaded
 * (sell or buy depending on basis). Auction-only items can be priced from an
 * optional external lowest-BIN JSON map configured via SKYBLOCK_LOWEST_BIN_URL
 * (compatible with Moulberry-style {SKYBLOCK_ID: price} dumps).
 */
export async function buildPriceBook(client: HypixelClient, options?: PriceBookOptions): Promise<PriceBook> {
  const basis: PriceBasis = options?.basis ?? "buy";
  const prices = new Map<string, number>();
  const sources: string[] = [];
  const sourceByItem = new Map<string, PriceSource>();
  const sourceStatus: Record<PriceSource, SourceStatus> = { bazaar: "unavailable", lowest_bin: "not_configured" };
  const sourceFreshness: Partial<Record<PriceSource, PriceFreshness>> = {};
  const warnings: string[] = [];
  let pricedAt: string | undefined;
  let pricedFromCache: boolean | undefined;

  try {
    const result = await client.hypixel<JsonObject>("/v2/skyblock/bazaar", undefined, { ttlMs: 30_000 });
    const products = asRecord(result.data.products);
    if (!products || result.data.success === false) throw new Error("Invalid Bazaar response");
    for (const [id, product] of Object.entries(products)) {
      const quick = asRecord(asRecord(product)?.quick_status);
      const price = basis === "sell" ? asNumber(quick?.sellPrice) : asNumber(quick?.buyPrice);
      if (price !== undefined && price > 0) {
        prices.set(id.toUpperCase(), price);
        sourceByItem.set(id.toUpperCase(), "bazaar");
      }
    }
    sources.push("bazaar");
    sourceStatus.bazaar = "available";
    sourceFreshness.bazaar = marketFreshness(result.meta.fetchedAt, result.meta.cached, result.data.lastUpdated);
    pricedAt = sourceFreshness.bazaar.sourceUpdatedAt;
    pricedFromCache = result.meta.cached;
  } catch {
    warnings.push("Bazaar prices are unavailable; valuations and upgrade costs may be incomplete.");
  }

  const lowbinUrl = process.env.SKYBLOCK_LOWEST_BIN_URL;
  if (options?.includeAuctionPrices === false) {
    sourceStatus.lowest_bin = "disabled";
  } else if (lowbinUrl) {
    const external = await loadExternalPrices(lowbinUrl, prices, sourceByItem);
    sourceStatus.lowest_bin = external.available ? "available" : "unavailable";
    if (external.added) sources.push("lowest_bin");
    if (external.freshness) sourceFreshness.lowest_bin = external.freshness;
    if (!external.available) warnings.push("Configured lowest-BIN prices are unavailable or contain no usable prices.");
  }

  return { prices, basis, sources, pricedAt, pricedFromCache, sourceByItem, sourceStatus, sourceFreshness, warnings };
}

function marketFreshness(retrievedAt: string | undefined, cached: boolean, timestamp?: unknown): PriceFreshness {
  const ms = asNumber(timestamp);
  const validTimestamp = ms !== undefined && ms > 0 && Number.isFinite(new Date(ms).getTime());
  const sourceUpdatedAt = validTimestamp ? new Date(ms).toISOString() : undefined;
  const age = freshnessFromTimestamp(sourceUpdatedAt, cached, 60);
  return {
    retrievedAt,
    sourceUpdatedAt,
    cached,
    dataAgeSeconds: age?.dataAgeSeconds ?? null,
    staleWarning: age?.staleWarning,
    note: sourceUpdatedAt ? undefined : "Upstream snapshot time is unknown; retrieval time does not establish price freshness."
  };
}

async function loadExternalPrices(
  url: string,
  prices: Map<string, number>,
  sourceByItem: Map<string, PriceSource>
): Promise<{ available: boolean; added?: boolean; freshness?: PriceFreshness }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(250, Math.min(30_000, parseEnvInteger("SKYBLOCK_LOWEST_BIN_TIMEOUT_MS", 10_000))));
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      return { available: false };
    }

    const json = (await response.json()) as unknown;
    const envelope = asRecord(json);
    const record = asRecord(envelope?.data) ?? envelope;
    if (!record) {
      return { available: false };
    }

    let added = false;
    let usable = 0;
    for (const [id, value] of Object.entries(record)) {
      if (["lastUpdated", "timestamp", "success"].includes(id)) continue;
      const price = asNumber(value);
      const key = id.toUpperCase();
      if (price !== undefined && price > 0) usable += 1;
      // Bazaar prices take precedence; only fill gaps from the auction source.
      if (price !== undefined && price > 0 && !prices.has(key)) {
        prices.set(key, price);
        sourceByItem.set(key, "lowest_bin");
        added = true;
      }
    }

    return {
      available: usable > 0,
      added,
      // Flat maps carry no timestamp. Only a wrapped map can provide metadata.
      freshness: marketFreshness(new Date().toISOString(), false, asRecord(envelope?.data) ? envelope?.lastUpdated : undefined)
    };
  } catch {
    return { available: false };
  } finally {
    clearTimeout(timeout);
  }
}

export function priceFor(priceBook: PriceBook, skyblockId: string | undefined): number | undefined {
  if (!skyblockId) {
    return undefined;
  }

  return priceBook.prices.get(skyblockId.toUpperCase());
}
