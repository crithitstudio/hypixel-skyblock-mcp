import type { HypixelClient } from "./hypixelClient.js";
import type { JsonObject } from "./types.js";
import { asNumber, asRecord, parseEnvInteger } from "./utils.js";

export type PriceBasis = "buy" | "sell";

export type PriceBook = {
  prices: Map<string, number>;
  basis: PriceBasis;
  sources: string[];
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

  try {
    const result = await client.hypixel<JsonObject>("/v2/skyblock/bazaar", undefined, { ttlMs: 30_000 });
    const products = asRecord(result.data.products) ?? {};
    for (const [id, product] of Object.entries(products)) {
      const quick = asRecord(asRecord(product)?.quick_status);
      const price = basis === "sell" ? asNumber(quick?.sellPrice) : asNumber(quick?.buyPrice);
      if (price !== undefined && price > 0) {
        prices.set(id.toUpperCase(), price);
      }
    }
    sources.push("bazaar");
  } catch {
    // Bazaar is optional; networth still reports liquid coins and coverage gaps.
  }

  const lowbinUrl = process.env.SKYBLOCK_LOWEST_BIN_URL;
  if (options?.includeAuctionPrices !== false && lowbinUrl) {
    const added = await loadExternalPrices(lowbinUrl, prices);
    if (added) {
      sources.push("lowest_bin");
    }
  }

  return { prices, basis, sources };
}

async function loadExternalPrices(url: string, prices: Map<string, number>): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), parseEnvInteger("SKYBLOCK_LOWEST_BIN_TIMEOUT_MS", 10_000));
  try {
    const response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) {
      return false;
    }

    const json = (await response.json()) as unknown;
    const record = asRecord(json) ?? asRecord(asRecord(json)?.data);
    if (!record) {
      return false;
    }

    let added = false;
    for (const [id, value] of Object.entries(record)) {
      const price = asNumber(value);
      const key = id.toUpperCase();
      // Bazaar prices take precedence; only fill gaps from the auction source.
      if (price !== undefined && price > 0 && !prices.has(key)) {
        prices.set(key, price);
        added = true;
      }
    }

    return added;
  } catch {
    return false;
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
