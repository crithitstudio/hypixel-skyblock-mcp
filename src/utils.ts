import type { JsonObject, RequestMeta } from "./types.js";

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

export function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function stripMinecraftFormatting(value: string): string {
  return value.replace(/\u00a7[0-9a-fk-or]/gi, "").trim();
}

export function normalizeUuid(value: string): string {
  return value.replace(/-/g, "").toLowerCase();
}

export function dashedUuid(value: string): string {
  const normalized = normalizeUuid(value);
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    return value;
  }

  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20)
  ].join("-");
}

export function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.replace(/-/g, ""));
}

export function compactObject<T extends JsonObject>(object: T): Partial<T> {
  const result: Partial<T> = {};

  for (const [key, value] of Object.entries(object) as [keyof T, T[keyof T]][]) {
    if (value === undefined || value === null) {
      continue;
    }

    if (Array.isArray(value) && value.length === 0) {
      continue;
    }

    if (isRecord(value) && Object.keys(value).length === 0) {
      continue;
    }

    result[key] = value;
  }

  return result;
}

export function takeEntries<T>(
  object: Record<string, T> | undefined,
  limit: number
): Record<string, T> {
  if (!object) {
    return {};
  }

  return Object.fromEntries(Object.entries(object).slice(0, limit));
}

export function numberOrZero(value: unknown): number {
  return asNumber(value) ?? 0;
}

export function percent(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return undefined;
  }

  return (numerator / denominator) * 100;
}

export function sortByNumeric<T>(
  values: T[],
  selector: (value: T) => number | undefined,
  direction: "asc" | "desc" = "desc"
): T[] {
  const sign = direction === "desc" ? -1 : 1;
  return [...values].sort((a, b) => {
    const av = selector(a);
    const bv = selector(b);
    if (av === undefined && bv === undefined) return 0;
    if (av === undefined) return 1;
    if (bv === undefined) return -1;
    return (av - bv) * sign;
  });
}

export function getPath(object: unknown, path: string[]): unknown {
  let cursor = object;

  for (const segment of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }

    cursor = cursor[segment];
  }

  return cursor;
}

export function pickPaths(object: unknown, paths: Record<string, string[]>): JsonObject {
  const result: JsonObject = {};

  for (const [name, path] of Object.entries(paths)) {
    const value = getPath(object, path);
    if (value !== undefined) {
      result[name] = value;
    }
  }

  return result;
}

export function parseEnvInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type Freshness = {
  fetchedAt: string;
  cached: boolean;
  dataAgeSeconds: number | null;
  staleWarning?: string;
  note?: string;
};

/**
 * Turns a raw fetch timestamp into agent-readable freshness: how many seconds old
 * the data is and an explicit warning string once it exceeds `staleAfterSeconds`.
 * Surfaced on volatile tool output so the model weights live data over its own
 * (stale) training memory instead of having to reason about an ISO timestamp.
 *
 * `note` lets callers clarify what the timestamp actually covers (e.g. for item
 * lookups the metadata is cached longer than the live price it carries).
 */
export function freshnessFromMeta(meta: RequestMeta, staleAfterSeconds: number, note?: string): Freshness {
  const fetchedMs = Date.parse(meta.fetchedAt);
  const dataAgeSeconds = Number.isFinite(fetchedMs) ? Math.max(0, Math.round((Date.now() - fetchedMs) / 1000)) : null;

  const freshness: Freshness = {
    fetchedAt: meta.fetchedAt,
    cached: meta.cached,
    dataAgeSeconds
  };

  if (dataAgeSeconds !== null && dataAgeSeconds > staleAfterSeconds) {
    freshness.staleWarning = `Data is ~${dataAgeSeconds}s old (> ${staleAfterSeconds}s); re-fetch before quoting exact prices.`;
  }
  if (note) {
    freshness.note = note;
  }
  return freshness;
}

/** Same as {@link freshnessFromMeta} but tolerates a possibly-undefined timestamp string. */
export function freshnessFromTimestamp(fetchedAt: string | undefined, cached: boolean, staleAfterSeconds: number): Freshness | undefined {
  if (!fetchedAt) {
    return undefined;
  }
  return freshnessFromMeta({ fetchedAt, cached, source: "" }, staleAfterSeconds);
}

export function createTextResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

export function redactApiKey(url: string): string {
  return url.replace(/([?&](?:key|apiKey|API-Key)=)[^&]+/gi, "$1<redacted>");
}
