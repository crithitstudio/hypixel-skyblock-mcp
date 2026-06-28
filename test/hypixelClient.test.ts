import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HypixelClient } from "../src/hypixelClient.js";
import { HypixelApiError, McpUserError } from "../src/errors.js";
import { VERSION } from "../src/version.js";

type ResponseInit = { status?: number; headers?: Record<string, string> };

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json", ...init?.headers }
  });
}

function makeClient(overrides?: ConstructorParameters<typeof HypixelClient>[0]): HypixelClient {
  return new HypixelClient({
    apiBase: "https://api.test",
    mojangBase: "https://mojang.test",
    apiKey: "test-key",
    ...overrides
  });
}

describe("HypixelClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns parsed data and reports rate-limit headers", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { success: true, value: 42 },
        { headers: { "RateLimit-Limit": "120", "RateLimit-Remaining": "119", "RateLimit-Reset": "30" } }
      )
    );

    const client = makeClient();
    const result = await client.hypixel("/resource/test");

    expect(result.data.value).toBe(42);
    expect(result.meta.cached).toBe(false);
    expect(result.meta.rateLimit).toEqual({ limit: 120, remaining: 119, resetSeconds: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a User-Agent carrying the package version", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    const client = makeClient();
    await client.hypixel("/resource/test");

    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers["User-Agent"]).toBe(`hypixel-skyblock-mcp/${VERSION}`);
  });

  it("serves repeat requests from cache without a second fetch", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, value: 1 }));

    const client = makeClient();
    const first = await client.hypixel("/resource/test", undefined, { ttlMs: 60_000 });
    const second = await client.hypixel("/resource/test", undefined, { ttlMs: 60_000 });

    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(second.data.value).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and then succeeds", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false, cause: "throttled" }, { status: 429, headers: { "Retry-After": "1" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, value: 7 }));

    const client = makeClient({ maxRetries: 2 });
    const promise = client.hypixel("/resource/test", undefined, { ttlMs: 0 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.data.value).toBe(7);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after exhausting retries on persistent 429", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse({ success: false, cause: "throttled" }, { status: 429 }));

    const client = makeClient({ maxRetries: 1 });
    const promise = client.hypixel("/resource/test", undefined, { ttlMs: 0 }).catch((error) => error);
    await vi.runAllTimersAsync();
    const error = await promise;

    expect(error).toBeInstanceOf(HypixelApiError);
    expect(error.status).toBe(429);
    // initial attempt + 1 retry
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-retryable client errors like 404", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, cause: "not found" }, { status: 404 }));

    const client = makeClient({ maxRetries: 3 });
    await expect(client.hypixel("/resource/test", undefined, { ttlMs: 0 })).rejects.toBeInstanceOf(HypixelApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries transient network failures", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError("network down"))
      .mockResolvedValueOnce(jsonResponse({ success: true, value: 5 }));

    const client = makeClient({ maxRetries: 2 });
    const promise = client.hypixel("/resource/test", undefined, { ttlMs: 0 });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.data.value).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws McpUserError without calling fetch when a key is required but missing", async () => {
    const client = makeClient({ apiKey: undefined });
    await expect(
      client.hypixel("/skyblock/profiles", undefined, { requiresApiKey: true })
    ).rejects.toBeInstanceOf(McpUserError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds the cache and evicts the oldest entry", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ id: "x", name: "y" }));

    const client = makeClient({ maxCacheEntries: 2 });
    await client.mojangProfile("alpha");
    await client.mojangProfile("beta");
    expect(client.cacheStats().entries).toBe(2);

    await client.mojangProfile("gamma");
    expect(client.cacheStats().entries).toBe(2);
    expect(client.cacheStats().maxEntries).toBe(2);
  });

  it("re-fetches an expired cache entry and drops the stale copy", async () => {
    // Drive only the clock (not the event loop) so Response body reads, which
    // rely on setImmediate, keep working while we expire the TTL.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    fetchMock.mockImplementation(async () => jsonResponse({ success: true, value: 1 }));

    const client = makeClient();
    await client.hypixel("/resource/test", undefined, { ttlMs: 1_000 });
    nowSpy.mockReturnValue(2_000);
    const second = await client.hypixel("/resource/test", undefined, { ttlMs: 1_000 });

    expect(second.meta.cached).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    nowSpy.mockRestore();
  });

  it("clearCache returns the number of evicted entries", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ id: "x", name: "y" }));

    const client = makeClient();
    await client.mojangProfile("alpha");
    await client.mojangProfile("beta");

    expect(client.clearCache()).toBe(2);
    expect(client.cacheStats().entries).toBe(0);
  });
});
