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
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("does not cache an unsuccessful Hypixel envelope", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ success: false, cause: "temporarily unavailable" }))
      .mockResolvedValueOnce(jsonResponse({ success: true, value: 42 }));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.hypixel("/test")).rejects.toMatchObject({ message: "temporarily unavailable" });
    expect(client.cacheStats().entries).toBe(0);
    expect((await client.hypixel("/test")).data.value).toBe(42);
  });

  it("preserves HTTP errors for HTML responses without retrying client errors", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>Forbidden</html>", { status: 403 }));
    const client = makeClient({ maxRetries: 1 });
    await expect(client.hypixel("/test")).rejects.toMatchObject({ name: "HypixelApiError", status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([429, 503])("retries a non-JSON HTTP %i using its retry hint", async (status) => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response("temporarily unavailable", { status, headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true, value: 7 }));
    const pending = makeClient().hypixel("/test");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).data.value).toBe(7);
  });

  it.each([{ body: null }, { body: [] }, { body: {} }, { body: { success: "true" } }])("rejects malformed successful Hypixel data: $body", async ({ body }) => {
    fetchMock.mockImplementation(async () => jsonResponse(body));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.hypixel("/test")).rejects.toMatchObject({ name: "HypixelApiError", message: expect.stringMatching(/invalid.*response/i) });
    expect(client.cacheStats().entries).toBe(0);
  });

  it("explains non-JSON successful responses without retrying parse failures", async () => {
    fetchMock.mockImplementation(async () => new Response("<html>challenge</html>"));
    const client = makeClient({ maxRetries: 1 });
    await expect(client.hypixel("/test")).rejects.toMatchObject({ name: "HypixelApiError", message: expect.stringMatching(/JSON/i) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent reads and isolates returned data from other callers and cache", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ success: true, nested: { value: 42 } }));
    const client = makeClient();
    const [first, second] = await Promise.all([client.hypixel("/test"), client.hypixel("/test")]);
    (first.data.nested as { value: number }).value = 0;
    expect(second.data.nested).toEqual({ value: 42 });
    const cached = await client.hypixel("/test");
    expect(cached.data.nested).toEqual({ value: 42 });
    (cached.data.nested as { value: number }).value = 1;
    expect((await client.hypixel("/test")).data.nested).toEqual({ value: 42 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clearing the cache detaches old requests so they cannot overwrite fresh data", async () => {
    let finishOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(jsonResponse({ success: true, value: "new" }));
    const client = makeClient();
    const old = client.hypixel("/test");
    client.clearCache();
    expect((await client.hypixel("/test")).data.value).toBe("new");
    finishOld(jsonResponse({ success: true, value: "old" }));
    await old;
    expect((await client.hypixel("/test")).data.value).toBe("new");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a failed coalesced request can be retried by a later caller", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(jsonResponse({ success: true, value: "recovered" }));
    const client = makeClient({ maxRetries: 0 });
    const results = await Promise.allSettled([client.hypixel("/test"), client.hypixel("/test")]);
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect((await client.hypixel("/test")).data.value).toBe("recovered");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds invalid and excessive numeric configuration", async () => {
    expect(makeClient({ maxCacheEntries: NaN }).cacheStats().maxEntries).toBe(500);
    expect(makeClient({ maxCacheEntries: 1e20 }).cacheStats().maxEntries).toBe(5_000);
    vi.stubEnv("HYPIXEL_MAX_RETRIES", "99oops");
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse({ success: false }, { status: 503 }));
    const failure = makeClient().hypixel("/test").catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await failure).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("caps excessive retry counts and recovers from non-finite retry configuration", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async () => jsonResponse({ success: false }, { status: 503 }));
    const capped = makeClient({ maxRetries: 1e10 }).hypixel("/test").catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await capped).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    fetchMock.mockClear();
    const invalid = makeClient({ maxRetries: NaN }).hypixel("/test").catch((error) => error);
    await vi.runAllTimersAsync();
    expect(await invalid).toMatchObject({ status: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("falls back to a finite timeout when configured with infinity", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const failure = makeClient({ timeoutMs: Infinity, maxRetries: 0 }).hypixel("/test").catch((error) => error);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await failure).toMatchObject({ status: 504, message: expect.stringContaining("15000ms") });
  });

  it("ttlMs zero bypasses an existing cached result", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, value: "old" }))
      .mockResolvedValueOnce(jsonResponse({ success: true, value: "fresh" }));
    const client = makeClient();
    await client.hypixel("/test");
    expect((await client.hypixel("/test", undefined, { ttlMs: 0 })).data.value).toBe("fresh");
  });

  it.each([null, {}, { id: "invalid", name: "Player" }])("rejects malformed Mojang profiles without caching them: %j", async (body) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(body))
      .mockResolvedValueOnce(jsonResponse({ id: "a".repeat(32), name: "Player" }));
    const client = makeClient({ maxRetries: 0 });
    await expect(client.mojangProfile("Player")).rejects.toMatchObject({ name: "HypixelApiError", message: expect.stringMatching(/invalid.*Mojang.*response/i) });
    expect(client.cacheStats().entries).toBe(0);
    expect((await client.mojangProfile("Player")).data.name).toBe("Player");
  });

  it("honors a date-form Retry-After value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false }, { status: 429, headers: { "Retry-After": "Tue, 22 Sep 2026 00:00:02 GMT" } }))
      .mockResolvedValueOnce(jsonResponse({ success: true }));
    const pending = makeClient().hypixel("/test");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    fetchMock.mockImplementation(async () => jsonResponse({ id: "a".repeat(32), name: "y" }));

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
    fetchMock.mockImplementation(async () => jsonResponse({ id: "a".repeat(32), name: "y" }));

    const client = makeClient();
    await client.mojangProfile("alpha");
    await client.mojangProfile("beta");

    expect(client.clearCache()).toBe(2);
    expect(client.cacheStats().entries).toBe(0);
  });
});
