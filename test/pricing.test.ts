import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPriceBook } from "../src/pricing.js";
import type { HypixelClient } from "../src/hypixelClient.js";

function client(data: unknown = { products: {} }): HypixelClient {
  return {
    hypixel: async () => ({ data, meta: { fetchedAt: "2026-09-22T12:00:00.000Z", cached: false } })
  } as unknown as HypixelClient;
}

describe("price source reliability", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("uses upstream Bazaar age even when the response was just fetched", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T12:00:00.000Z"));
    const result = await buildPriceBook(client({
      lastUpdated: Date.parse("2026-09-22T11:00:00.000Z"),
      products: { DIAMOND: { quick_status: { buyPrice: 10, sellPrice: 8 } } }
    }));
    expect(result.pricedAt).toBe("2026-09-22T11:00:00.000Z");
    expect(result.sourceFreshness?.bazaar?.dataAgeSeconds).toBe(3600);
    expect(result.sourceFreshness?.bazaar?.staleWarning).toBeTruthy();
    expect(result.prices.get("DIAMOND")).toBe(10);
  });

  it("loads wrapped lowest-BIN maps without overriding Bazaar prices", async () => {
    vi.stubEnv("SKYBLOCK_LOWEST_BIN_URL", "https://prices.test/map");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: { HYPERION: 1234, DIAMOND: 99 } })));
    const result = await buildPriceBook(client({ products: { DIAMOND: { quick_status: { buyPrice: 10 } } } }));
    expect(result.prices.get("HYPERION")).toBe(1234);
    expect(result.prices.get("DIAMOND")).toBe(10);
    expect(result.sourceStatus?.lowest_bin).toBe("available");
    expect(result.sourceFreshness?.lowest_bin?.retrievedAt).toBeDefined();
    expect(result.sourceFreshness?.lowest_bin?.dataAgeSeconds).toBeNull();
  });

  it("reports failed sources without fabricating a fresh snapshot", async () => {
    vi.stubEnv("SKYBLOCK_LOWEST_BIN_URL", "https://prices.test/map");
    vi.stubGlobal("fetch", async () => new Response("down", { status: 503 }));
    const failed = { hypixel: async () => { throw new Error("Bazaar unavailable"); } } as unknown as HypixelClient;
    const result = await buildPriceBook(failed);
    expect(result.prices.size).toBe(0);
    expect(result.sourceStatus).toMatchObject({ bazaar: "unavailable", lowest_bin: "unavailable" });
    expect(result.warnings?.length).toBeGreaterThanOrEqual(2);
    expect(result.pricedAt).toBeUndefined();
  });

  it("rejects malformed Bazaar product envelopes as unavailable", async () => {
    const result = await buildPriceBook(client({ products: [] }));
    expect(result.sourceStatus?.bazaar).toBe("unavailable");
    expect(result.sources).not.toContain("bazaar");
  });

  it("does not interpret retrieval time as upstream age when no snapshot timestamp exists", async () => {
    const result = await buildPriceBook(client({ products: { DIAMOND: { quick_status: { buyPrice: 10 } } } }));
    expect(result.pricedAt).toBeUndefined();
    expect(result.sourceFreshness?.bazaar).toMatchObject({ retrievedAt: "2026-09-22T12:00:00.000Z", dataAgeSeconds: null });
  });
});
