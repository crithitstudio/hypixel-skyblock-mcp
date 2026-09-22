import { HypixelApiError, McpUserError } from "./errors.js";
import type { ApiResult, HypixelEnvelope, RateLimitInfo } from "./types.js";
import { isRecord, redactApiKey } from "./utils.js";
import { VERSION } from "./version.js";

type CacheEntry = {
  expiresAt: number;
  value: ApiResult<unknown>;
};

type RequestOptions = {
  requiresApiKey?: boolean;
  ttlMs?: number;
  apiKeyOptional?: boolean;
};

// HTTP statuses worth retrying: 429 (rate limited) and transient gateway/server
// errors. Other 4xx responses are client mistakes and are never retried.
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

// Cap any server-provided backoff (Retry-After / RateLimit-Reset) so a hostile
// or buggy header cannot stall a request for minutes.
const MAX_BACKOFF_MS = 30_000;

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed)
    ? Math.max(min, Math.min(max, Math.floor(parsed)))
    : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HypixelClient {
  private readonly apiBase: string;
  private readonly mojangBase: string;
  private readonly apiKey?: string;
  private readonly defaultTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxCacheEntries: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<ApiResult<unknown>>>();
  private cacheGeneration = 0;

  constructor(options?: {
    apiBase?: string;
    mojangBase?: string;
    apiKey?: string;
    defaultTtlMs?: number;
    timeoutMs?: number;
    maxRetries?: number;
    maxCacheEntries?: number;
  }) {
    this.apiBase = (options?.apiBase ?? process.env.HYPIXEL_API_BASE ?? "https://api.hypixel.net").replace(/\/$/, "");
    this.mojangBase = (options?.mojangBase ?? process.env.MOJANG_API_BASE ?? "https://api.mojang.com").replace(/\/$/, "");
    this.apiKey = options?.apiKey ?? process.env.HYPIXEL_API_KEY ?? process.env.HYPIXEL_API_TOKEN;
    this.defaultTtlMs = boundedInteger(options?.defaultTtlMs ?? process.env.HYPIXEL_CACHE_TTL_MS, 60_000, 0, 86_400_000);
    this.timeoutMs = boundedInteger(options?.timeoutMs ?? process.env.HYPIXEL_REQUEST_TIMEOUT_MS, 15_000, 1, 120_000);
    this.maxRetries = boundedInteger(options?.maxRetries ?? process.env.HYPIXEL_MAX_RETRIES, 2, 0, 5);
    this.maxCacheEntries = boundedInteger(options?.maxCacheEntries ?? process.env.HYPIXEL_CACHE_MAX_ENTRIES, 500, 1, 5_000);
  }

  hasApiKey(): boolean {
    return Boolean(this.apiKey);
  }

  async hypixel<T extends HypixelEnvelope>(
    path: string,
    query?: Record<string, string | number | boolean | undefined>,
    options?: RequestOptions
  ): Promise<ApiResult<T>> {
    if (options?.requiresApiKey && !this.apiKey) {
      throw new McpUserError(
        "This Hypixel endpoint requires HYPIXEL_API_KEY. Create an application key at https://developer.hypixel.net/ and pass it in the MCP server environment."
      );
    }

    const url = this.buildUrl(this.apiBase, path, query);
    const headers: HeadersInit = {
      Accept: "application/json",
      "User-Agent": `hypixel-skyblock-mcp/${VERSION}`
    };

    if (this.apiKey && (options?.requiresApiKey || options?.apiKeyOptional)) {
      headers["API-Key"] = this.apiKey;
    }

    return this.fetchJson<T>(url, headers, options?.ttlMs, (result) => {
      if (isRecord(result.data) && result.data.success === false) {
        const cause = typeof result.data.cause === "string" ? result.data.cause : "Hypixel API returned success=false";
        throw new HypixelApiError(cause, 200, { rateLimit: result.meta.rateLimit, body: result.data });
      }
      if (!isRecord(result.data) || result.data.success !== true) {
        throw new HypixelApiError("Invalid Hypixel response: expected an object with success=true.", 200);
      }
    });
  }

  async mojangProfile(username: string, ttlMs = 24 * 60 * 60 * 1000): Promise<ApiResult<{ id: string; name: string }>> {
    const encodedName = encodeURIComponent(username);
    const url = `${this.mojangBase}/users/profiles/minecraft/${encodedName}`;
    return this.fetchJson<{ id: string; name: string }>(url, { Accept: "application/json" }, ttlMs, ({ data }) => {
      if (!isRecord(data) || typeof data.id !== "string" || !/^[0-9a-f]{32}$/i.test(data.id) ||
          typeof data.name !== "string" || !data.name.trim()) {
        throw new HypixelApiError("Invalid Mojang profile response: expected a Minecraft UUID and username.", 200);
      }
    });
  }

  clearCache(): number {
    const cleared = this.cache.size;
    this.cacheGeneration += 1;
    this.cache.clear();
    this.inFlight.clear();
    return cleared;
  }

  cacheStats(): { entries: number; maxEntries: number } {
    return { entries: this.cache.size, maxEntries: this.maxCacheEntries };
  }

  private buildUrl(base: string, path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(path.startsWith("/") ? path : `/${path}`, `${base}/`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }

  private async fetchJson<T>(
    url: string,
    headers: HeadersInit,
    ttlMs = this.defaultTtlMs,
    validate?: (result: ApiResult<T>) => void
  ): Promise<ApiResult<T>> {
    const effectiveTtl = boundedInteger(ttlMs, this.defaultTtlMs, 0, 86_400_000);
    const cacheKey = `${url}|${JSON.stringify(headers)}`;
    const cached = effectiveTtl > 0 ? this.cache.get(cacheKey) : undefined;

    if (cached) {
      if (cached.expiresAt > Date.now()) {
        const result = structuredClone(cached.value) as ApiResult<T>;
        result.meta.cached = true;
        return result;
      }
      // Expired: drop it so the cache does not accumulate stale entries.
      this.cache.delete(cacheKey);
    }

    const requestKey = `${cacheKey}|${effectiveTtl}`;
    const existing = this.inFlight.get(requestKey);
    if (existing) return structuredClone(await existing) as ApiResult<T>;

    const generation = this.cacheGeneration;
    const pending = this.fetchWithRetries<T>(url, headers, validate).then((result) => {
      if (effectiveTtl > 0 && generation === this.cacheGeneration) {
        this.storeInCache(cacheKey, { expiresAt: Date.now() + effectiveTtl, value: result });
      }
      return result;
    });
    this.inFlight.set(requestKey, pending);
    try {
      // Cache and coalesced callers each receive independent snapshots.
      return structuredClone(await pending);
    } finally {
      if (this.inFlight.get(requestKey) === pending) this.inFlight.delete(requestKey);
    }
  }

  private async fetchWithRetries<T>(
    url: string,
    headers: HeadersInit,
    validate?: (result: ApiResult<T>) => void
  ): Promise<ApiResult<T>> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = await this.fetchAttempt<T>(url, headers);
        validate?.(result);
        return result;
      } catch (error) {
        if (attempt >= this.maxRetries || !this.isRetryable(error)) {
          throw error;
        }
        await sleep(this.retryDelayMs(error, attempt));
      }
    }

    // Unreachable: the loop either returns or throws, but satisfies the type checker.
    throw new Error("Request retry loop exhausted unexpectedly.");
  }

  private async fetchAttempt<T>(url: string, headers: HeadersInit): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal
      });
      const rateLimit = this.rateLimitFromHeaders(response.headers);
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        if (response.ok) {
          throw new HypixelApiError("Upstream returned invalid JSON. The endpoint may be blocked or temporarily unavailable.", response.status);
        }
        // Gateway/CDN errors often contain HTML. Preserve their HTTP status and
        // retry headers even when there is no JSON error envelope.
      }

      if (!response.ok) {
        const cause = isRecord(parsed) && typeof parsed.cause === "string" ? parsed.cause : response.statusText || `Upstream HTTP ${response.status}`;
        throw new HypixelApiError(cause, response.status, { rateLimit, body: parsed });
      }

      return {
        data: parsed as T,
        meta: {
          cached: false,
          fetchedAt: new Date().toISOString(),
          rateLimit,
          source: redactApiKey(url)
        }
      };
    } catch (error) {
      if (error instanceof HypixelApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new HypixelApiError(`Request timed out after ${this.timeoutMs}ms`, 504);
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private isRetryable(error: unknown): boolean {
    if (error instanceof HypixelApiError) {
      return RETRYABLE_STATUSES.has(error.status);
    }
    // A non-HTTP error here is a network/DNS failure (fetch threw a TypeError);
    // those are transient and worth one more attempt.
    return error instanceof TypeError;
  }

  /**
   * Picks a backoff delay before the next attempt. Honors a server-provided
   * reset/Retry-After hint when present (capped), otherwise uses capped
   * exponential backoff with jitter to avoid thundering-herd retries.
   */
  private retryDelayMs(error: unknown, attempt: number): number {
    if (error instanceof HypixelApiError) {
      const resetSeconds = error.rateLimit?.resetSeconds;
      if (resetSeconds !== undefined && resetSeconds > 0) {
        return Math.min(resetSeconds * 1000, MAX_BACKOFF_MS);
      }
    }

    const exponential = 500 * 2 ** attempt;
    const jitter = Math.floor(Math.random() * 250);
    return Math.min(exponential + jitter, MAX_BACKOFF_MS);
  }

  private storeInCache(key: string, entry: CacheEntry): void {
    // Bound the cache so a long-running server cannot leak memory. Evict the
    // oldest insertion (Map preserves insertion order) once at capacity.
    if (!this.cache.has(key) && this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, entry);
  }

  private rateLimitFromHeaders(headers: Headers): RateLimitInfo | undefined {
    const limit = this.headerNumber(headers, "RateLimit-Limit");
    const remaining = this.headerNumber(headers, "RateLimit-Remaining");
    // Standard Retry-After (RFC 9110, delta-seconds form) is the fallback when
    // Hypixel sends it on a 429 instead of the RateLimit-Reset header.
    const retryAfter = headers.get("Retry-After");
    const retryDate = retryAfter && !/^\d+(?:\.\d+)?$/.test(retryAfter.trim()) ? Date.parse(retryAfter) : NaN;
    const retrySeconds = Number.isFinite(retryDate)
      ? Math.max(0, Math.ceil((retryDate - Date.now()) / 1000))
      : this.headerNumber(headers, "Retry-After");
    const reset = this.headerNumber(headers, "RateLimit-Reset");
    const resetSeconds = reset === undefined ? retrySeconds : retrySeconds === undefined ? reset : Math.max(reset, retrySeconds);

    if (limit === undefined && remaining === undefined && resetSeconds === undefined) {
      return undefined;
    }

    return { limit, remaining, resetSeconds };
  }

  private headerNumber(headers: Headers, name: string): number | undefined {
    const value = headers.get(name);
    if (!value) {
      return undefined;
    }

    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  }
}
