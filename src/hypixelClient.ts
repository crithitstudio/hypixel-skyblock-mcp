import { HypixelApiError, McpUserError } from "./errors.js";
import type { ApiResult, HypixelEnvelope, JsonObject, RateLimitInfo } from "./types.js";
import { isRecord, parseEnvInteger, redactApiKey } from "./utils.js";

type CacheEntry = {
  expiresAt: number;
  value: ApiResult<unknown>;
};

type RequestOptions = {
  requiresApiKey?: boolean;
  ttlMs?: number;
  apiKeyOptional?: boolean;
};

export class HypixelClient {
  private readonly apiBase: string;
  private readonly mojangBase: string;
  private readonly apiKey?: string;
  private readonly defaultTtlMs: number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options?: {
    apiBase?: string;
    mojangBase?: string;
    apiKey?: string;
    defaultTtlMs?: number;
    timeoutMs?: number;
  }) {
    this.apiBase = (options?.apiBase ?? process.env.HYPIXEL_API_BASE ?? "https://api.hypixel.net").replace(/\/$/, "");
    this.mojangBase = (options?.mojangBase ?? process.env.MOJANG_API_BASE ?? "https://api.mojang.com").replace(/\/$/, "");
    this.apiKey = options?.apiKey ?? process.env.HYPIXEL_API_KEY ?? process.env.HYPIXEL_API_TOKEN;
    this.defaultTtlMs = options?.defaultTtlMs ?? parseEnvInteger("HYPIXEL_CACHE_TTL_MS", 60_000);
    this.timeoutMs = options?.timeoutMs ?? parseEnvInteger("HYPIXEL_REQUEST_TIMEOUT_MS", 15_000);
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
      "User-Agent": "hypixel-skyblock-mcp/0.4.0"
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

  clearCache(): void {
    this.cache.clear();
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

    if (cached && cached.expiresAt > Date.now()) {
      return {
        data: cached.value.data as T,
        meta: {
          ...cached.value.meta,
          cached: true
        }
      };
    }

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

      const result: ApiResult<T> = {
        data: parsed as T,
        meta: {
          cached: false,
          fetchedAt: new Date().toISOString(),
          rateLimit,
          source: redactApiKey(url)
        }
      };

      if (ttlMs > 0) {
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + ttlMs,
          value: result as ApiResult<unknown>
        });
      }

      return result;
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

  private rateLimitFromHeaders(headers: Headers): RateLimitInfo | undefined {
    const limit = this.headerNumber(headers, "RateLimit-Limit");
    const remaining = this.headerNumber(headers, "RateLimit-Remaining");
    const resetSeconds = this.headerNumber(headers, "RateLimit-Reset");

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
