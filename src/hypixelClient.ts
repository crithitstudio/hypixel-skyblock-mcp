import { HypixelApiError, McpUserError } from "./errors.js";
import type { ApiResult, HypixelEnvelope, JsonObject, RateLimitInfo } from "./types.js";
import { isRecord, parseEnvInteger, redactApiKey } from "./utils.js";
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
    this.defaultTtlMs = options?.defaultTtlMs ?? parseEnvInteger("HYPIXEL_CACHE_TTL_MS", 60_000);
    this.timeoutMs = options?.timeoutMs ?? parseEnvInteger("HYPIXEL_REQUEST_TIMEOUT_MS", 15_000);
    this.maxRetries = Math.max(0, options?.maxRetries ?? parseEnvInteger("HYPIXEL_MAX_RETRIES", 2));
    this.maxCacheEntries = Math.max(1, options?.maxCacheEntries ?? parseEnvInteger("HYPIXEL_CACHE_MAX_ENTRIES", 500));
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

    const result = await this.fetchJson<T>(url, headers, options?.ttlMs);
    if (result.data.success === false) {
      const cause = typeof result.data.cause === "string" ? result.data.cause : "Hypixel API returned success=false";
      throw new HypixelApiError(cause, 200, { rateLimit: result.meta.rateLimit, body: result.data });
    }

    return result;
  }

  async mojangProfile(username: string, ttlMs = 24 * 60 * 60 * 1000): Promise<ApiResult<{ id: string; name: string }>> {
    const encodedName = encodeURIComponent(username);
    const url = `${this.mojangBase}/users/profiles/minecraft/${encodedName}`;
    return this.fetchJson<{ id: string; name: string }>(url, { Accept: "application/json" }, ttlMs);
  }

  clearCache(): number {
    const cleared = this.cache.size;
    this.cache.clear();
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

  private async fetchJson<T>(url: string, headers: HeadersInit, ttlMs = this.defaultTtlMs): Promise<ApiResult<T>> {
    const cacheKey = `${url}|${JSON.stringify(headers)}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      if (cached.expiresAt > Date.now()) {
        return {
          data: cached.value.data as T,
          meta: {
            ...cached.value.meta,
            cached: true
          }
        };
      }
      // Expired: drop it so the cache does not accumulate stale entries.
      this.cache.delete(cacheKey);
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        const result = await this.fetchAttempt<T>(url, headers);

        if (ttlMs > 0) {
          this.storeInCache(cacheKey, {
            expiresAt: Date.now() + ttlMs,
            value: result as ApiResult<unknown>
          });
        }

        return result;
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxRetries || !this.isRetryable(error)) {
          throw error;
        }
        await sleep(this.retryDelayMs(error, attempt));
      }
    }

    // Unreachable: the loop either returns or throws, but satisfies the type checker.
    throw lastError;
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
      const parsed = text ? (JSON.parse(text) as unknown) : null;

      if (!response.ok) {
        const cause = isRecord(parsed) && typeof parsed.cause === "string" ? parsed.cause : response.statusText;
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
    return error instanceof Error && error.name !== "McpUserError";
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
    const resetSeconds = this.headerNumber(headers, "RateLimit-Reset") ?? this.headerNumber(headers, "Retry-After");

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

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
}
