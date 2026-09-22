import type { JsonObject } from "./types.js";
import { McpUserError } from "./errors.js";
import { asArray, asRecord, asString, compactObject, stripMinecraftFormatting } from "./utils.js";
import { VERSION } from "./version.js";

const DEFAULT_WIKI_BASE = "https://wiki.hypixel.net";
const DEFAULT_WIKI_TTL_MS = 10 * 60_000;
const WIKI_SOURCE = "official_hypixel_skyblock_wiki";
const CONFIGURED_SOURCE = "configured_mediawiki";
const WIKI_RETIREMENT_URL = "https://hypixel.net/threads/end-of-the-official-hypixel-wiki-july-2026.6112020/";
const TOP_LEVEL_ITEM_FIELDS = [
  "item",
  "summary",
  "obtaining",
  "upgrading",
  "usage",
  "lore",
  "trivia",
  "history",
  "upgradeslow",
  "upgrades",
  "seealso",
  "references"
];

type WikiCacheEntry = {
  expiresAt: number;
  value: WikiResult;
};

type WikiResult = { data: JsonObject; meta: JsonObject };

type WikiPageOptions = {
  title?: string;
  search?: string;
  includeRaw?: boolean;
  maxSectionChars?: number;
};

type WikiSearchOptions = {
  limit?: number;
};

const wikiCache = new Map<string, WikiCacheEntry>();
const wikiInFlight = new Map<string, Promise<WikiResult>>();
let wikiCacheGeneration = 0;

export function clearWikiCache(): number {
  const cleared = wikiCache.size;
  wikiCacheGeneration += 1;
  wikiCache.clear();
  wikiInFlight.clear();
  return cleared;
}

export function wikiCacheStats(): { entries: number; maxEntries: number } {
  return { entries: wikiCache.size, maxEntries: wikiInteger("SKYBLOCK_WIKI_CACHE_MAX_ENTRIES", 200, 1, 5_000) };
}

function wikiInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = raw?.trim() ? Number(raw) : NaN;
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
}

function wikiBase(): URL {
  try {
    const base = new URL(process.env.SKYBLOCK_WIKI_BASE?.trim() || DEFAULT_WIKI_BASE);
    if (!["https:", "http:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid base");
    return base;
  } catch {
    throw new McpUserError("SKYBLOCK_WIKI_BASE must be an HTTP(S) MediaWiki base URL without embedded credentials.");
  }
}

function retiredWikiResult(): JsonObject | undefined {
  if (wikiBase().hostname.toLowerCase() !== "wiki.hypixel.net") return undefined;
  return {
    found: false,
    available: false,
    status: "retired",
    source: WIKI_SOURCE,
    official: true,
    retiredAt: "2026-07-21",
    announcementUrl: WIKI_RETIREMENT_URL,
    note: "Hypixel retired its official wiki in July 2026. Live official wiki content is unavailable. Configure SKYBLOCK_WIKI_BASE to use a separate MediaWiki source; its content will be labeled non-official."
  };
}

export async function searchOfficialWiki(search: string, options?: WikiSearchOptions): Promise<JsonObject> {
  const query = search.trim();
  if (!query) {
    return { error: "Provide a non-empty search query." };
  }
  const retired = retiredWikiResult();
  if (retired) return { ...retired, query };

  const limit = clamp(options?.limit, 10, 1, 25);
  const result = await fetchWikiJson({
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: String(limit)
  });
  const searchInfo = asRecord(asRecord(result.data.query)?.searchinfo);
  const hits = (asArray(asRecord(result.data.query)?.search) ?? []).map(summarizeSearchHit);

  return compactObject({
    source: CONFIGURED_SOURCE,
    official: false,
    meta: result.meta,
    query,
    totalHits: searchInfo?.totalhits,
    results: hits
  });
}

export async function getOfficialWikiPage(options: WikiPageOptions): Promise<JsonObject> {
  const requestedTitle = options.title?.trim();
  const search = options.search?.trim();

  if (!requestedTitle && !search) {
    return { error: "Provide either title or search." };
  }
  const retired = retiredWikiResult();
  if (retired) return compactObject({ ...retired, title: requestedTitle, search });

  const direct = requestedTitle ? await fetchWikiPageByTitle(requestedTitle) : undefined;
  if (direct && !direct.missing) {
    return formatWikiPage(direct.page, "title", options);
  }

  const query = search ?? requestedTitle;
  if (!query) {
    return {
      found: false,
      source: CONFIGURED_SOURCE,
      official: false,
      title: requestedTitle,
      note: "No configured wiki page matched the requested title."
    };
  }

  const searchResult = await searchOfficialWiki(query, { limit: 5 });
  const candidates = asArray(searchResult.results) as JsonObject[] | undefined;
  const selected = chooseSearchResult(candidates ?? [], requestedTitle ?? query);
  const selectedTitle = asString(selected?.title);
  if (!selectedTitle) {
    return compactObject({
      found: false,
      source: CONFIGURED_SOURCE,
      official: false,
      title: requestedTitle,
      search: query,
      candidates,
      note: "No configured wiki page matched the requested title or search."
    });
  }

  const page = await fetchWikiPageByTitle(selectedTitle);
  if (page.missing) {
    return compactObject({
      found: false,
      source: CONFIGURED_SOURCE,
      official: false,
      title: selectedTitle,
      search: query,
      candidates,
      note: "Search found a title, but the page content could not be fetched."
    });
  }

  return {
    ...formatWikiPage(page.page, "search", options),
    candidates
  };
}

export async function getOfficialWikiItemContext(
  item: { id: string; name?: string },
  options?: { includeRaw?: boolean; maxSectionChars?: number }
): Promise<JsonObject> {
  const name = item.name?.trim();
  const idTitle = item.id.replace(/_/g, " ");
  return getOfficialWikiPage({
    title: name || idTitle,
    search: name ? `${name} ${item.id}` : idTitle,
    includeRaw: options?.includeRaw,
    maxSectionChars: options?.maxSectionChars
  });
}

export function summarizeWikiWikitext(content: string, maxSectionChars = 900): JsonObject {
  const fields = ["summary", "obtaining", "upgrading", "usage", "history", "trivia"] as const;
  const sections: JsonObject = {};

  for (const field of fields) {
    const value = extractItemPageField(content, field);
    const cleaned = value ? cleanWikiText(value, maxSectionChars) : undefined;
    if (cleaned) {
      sections[field] = cleaned;
    }
  }

  if (Object.keys(sections).length > 0) {
    return sections;
  }

  const fallback = cleanWikiText(content, maxSectionChars);
  return fallback ? { summary: fallback } : {};
}

function summarizeSearchHit(hit: unknown): JsonObject {
  const record = asRecord(hit) ?? {};
  return compactObject({
    title: record.title,
    pageId: record.pageid,
    wordCount: record.wordcount,
    size: record.size,
    updatedAt: record.timestamp,
    snippet: cleanSearchSnippet(asString(record.snippet))
  });
}

function chooseSearchResult(candidates: JsonObject[], query: string): JsonObject | undefined {
  const normalizedQuery = normalizeTitle(query);
  return candidates.find((candidate) => normalizeTitle(asString(candidate.title) ?? "") === normalizedQuery) ?? candidates[0];
}

async function fetchWikiPageByTitle(title: string): Promise<{ missing: boolean; page: JsonObject }> {
  const result = await fetchWikiJson({
    action: "query",
    prop: "info|revisions",
    titles: title,
    redirects: "1",
    inprop: "url",
    rvprop: "content|timestamp",
    rvslots: "main"
  });
  const page = asRecord(asArray(asRecord(result.data.query)?.pages)?.[0]) ?? {};
  return { missing: Boolean(page.missing), page: { ...page, meta: result.meta } };
}

function formatWikiPage(page: JsonObject, matchedBy: "title" | "search", options: WikiPageOptions): JsonObject {
  const revision = asRecord(asArray(page.revisions)?.[0]);
  const slots = asRecord(revision?.slots);
  const mainSlot = asRecord(slots?.main);
  const content = asString(mainSlot?.content) ?? "";

  return compactObject({
    found: true,
    source: CONFIGURED_SOURCE,
    official: false,
    matchedBy,
    title: page.title,
    pageId: page.pageid,
    url: page.fullurl ?? page.canonicalurl,
    lastRevisionAt: revision?.timestamp,
    sections: summarizeWikiWikitext(content, options.maxSectionChars),
    rawWikitext: options.includeRaw ? content : undefined,
    meta: page.meta
  });
}

async function fetchWikiJson(params: Record<string, string>): Promise<WikiResult> {
  const base = wikiBase();
  // Preserve installations hosted under a path such as /w/.
  const url = new URL("api.php", `${base.toString().replace(/\/$/, "")}/`);
  const ttlMs = wikiInteger("SKYBLOCK_WIKI_CACHE_TTL_MS", DEFAULT_WIKI_TTL_MS, 0, 86_400_000);

  for (const [key, value] of Object.entries({
    format: "json",
    formatversion: "2",
    ...params
  })) {
    url.searchParams.set(key, value);
  }

  const cacheKey = url.toString();
  const cached = wikiCache.get(cacheKey);
  if (ttlMs > 0 && cached && cached.expiresAt > Date.now()) {
    const result = structuredClone(cached.value);
    result.meta.cached = true;
    return result;
  }
  if (cached) {
    wikiCache.delete(cacheKey);
  }

  const existing = wikiInFlight.get(cacheKey);
  if (existing) return structuredClone(await existing);
  const generation = wikiCacheGeneration;
  const pending = requestWikiJson(cacheKey, params).then((result) => {
    if (ttlMs > 0 && generation === wikiCacheGeneration) {
      const maxEntries = wikiCacheStats().maxEntries;
      while (wikiCache.size >= maxEntries) {
        const oldest = wikiCache.keys().next().value;
        if (oldest === undefined) break;
        wikiCache.delete(oldest);
      }
      wikiCache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value: result });
    }
    return result;
  });
  wikiInFlight.set(cacheKey, pending);
  try {
    return structuredClone(await pending);
  } finally {
    if (wikiInFlight.get(cacheKey) === pending) wikiInFlight.delete(cacheKey);
  }
}

async function requestWikiJson(url: string, params: Record<string, string>): Promise<WikiResult> {
  const timeoutMs = wikiInteger("SKYBLOCK_WIKI_TIMEOUT_MS", 10_000, 1, 120_000);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `hypixel-skyblock-mcp/${VERSION}`
      },
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Configured wiki API returned HTTP ${response.status}: ${response.statusText}`);
    }

    let data: unknown;
    try {
      data = JSON.parse(text) as unknown;
    } catch {
      throw new Error("Configured wiki API did not return JSON. Check SKYBLOCK_WIKI_BASE; the endpoint may be blocked or unavailable.");
    }

    const record = asRecord(data);
    const apiError = asRecord(record?.error);
    if (apiError) {
      throw new Error(`Configured wiki API error ${asString(apiError.code) ?? "unknown"}: ${asString(apiError.info) ?? "request failed"}`);
    }
    const query = asRecord(record?.query);
    if (!record || !query) throw new Error("Invalid wiki response: expected a MediaWiki query result.");
    if (params.list === "search") {
      const hits = asArray(query.search);
      if (!hits || hits.some((hit) => !asString(asRecord(hit)?.title))) {
        throw new Error("Invalid wiki response: expected search results with page titles.");
      }
    } else {
      const page = asRecord(asArray(query.pages)?.[0]);
      if (!page || !asString(page.title)) throw new Error("Invalid wiki response: expected a page with a title.");
      if (page.invalid) throw new McpUserError(`Invalid wiki title: ${asString(page.invalidreason) ?? page.title}`);
      if (!page.missing) {
        const revision = asRecord(asArray(page.revisions)?.[0]);
        if (asString(asRecord(asRecord(revision?.slots)?.main)?.content) === undefined) {
          throw new Error("Invalid wiki response: page revision content is unavailable.");
        }
      }
    }

    return {
      data: record,
      meta: {
        cached: false,
        source: url,
        fetchedAt: new Date().toISOString()
      }
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Configured wiki request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractItemPageField(content: string, field: string): string | undefined {
  const startMatch = new RegExp(`(?:^|\\n)\\|${escapeRegExp(field)}\\s*=`, "i").exec(content);
  if (!startMatch) {
    return undefined;
  }

  const start = startMatch.index + startMatch[0].length;
  const rest = content.slice(start);
  const endMatch = new RegExp(`\\n\\|(?:${TOP_LEVEL_ITEM_FIELDS.map(escapeRegExp).join("|")})\\s*=`, "i").exec(rest);
  return rest.slice(0, endMatch ? endMatch.index : undefined).trim();
}

function cleanWikiText(value: string, maxChars: number): string | undefined {
  let text = value
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\{\{\{!\}\}/g, "")
    .replace(/\{\{!\}\}/g, "|")
    .replace(/\{\{color\|[^|{}]+\|([^{}]+)\}\}/gi, "$1")
    .replace(/\{\{Item\/([A-Z0-9_]+)\}\}/g, "$1")
    .replace(/\{\{Recipe\/([A-Z0-9_]+)\}\}/g, "recipe: $1")
    .replace(/\{\{Image\|[^{}]*?link=([^|}]+)[^{}]*\}\}/g, "$1")
    .replace(/\{\{UsageLore\s*\|([\s\S]*?)\}\}/gi, (_match, body: string) => formatUsageLore(body))
    .replace(/\{\{SkyBlock Version\s*\|([\s\S]*?)\}\}/gi, (_match, body: string) => formatSkyBlockVersion(body))
    .replace(/\{\{SC\|([^|{}]+)\|([^|{}]+)\|([^|{}]+)\}\}/g, "$1 $2 -> $3")
    .replace(/\{\{([A-Za-z ]+)\|([^{}]+)\}\}/g, (_match, name: string, body: string) => `${name.trim()} ${body.split("|").join(" ")}`)
    .replace(/\{\{([A-Za-z ]+)\}\}/g, "$1")
    .replace(/\{\{[^{}]+\}\}/g, "")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'''?/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?blockquote>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/^[ \t]*[*#]+[ \t]*/gm, "")
    .replace(/^[ \t]*[!|}].*$/gm, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = stripMinecraftFormatting(text);
  if (!text) {
    return undefined;
  }

  if (text.length <= maxChars) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function formatUsageLore(body: string): string {
  const title = extractTemplateParam(body, "title");
  const description = extractTemplateParam(body, "description");
  const manaCost = extractTemplateParam(body, "manacost");
  const cooldown = extractTemplateParam(body, "cooldown");
  return [
    title ? `Ability ${title}:` : "Ability:",
    description,
    manaCost ? `Mana cost ${manaCost}.` : undefined,
    cooldown ? `Cooldown ${cooldown}.` : undefined
  ]
    .filter(Boolean)
    .join(" ");
}

function formatSkyBlockVersion(body: string): string {
  const patch = extractTemplateParam(body, "patch");
  const changes = [...body.matchAll(/\|\s*change\d+\s*=\s*([^\n]+)/gi)].map((match) => match[1]?.trim()).filter(Boolean);
  return [patch ? `Patch ${patch}:` : "Patch:", changes.join(" ")].filter(Boolean).join(" ");
}

function extractTemplateParam(body: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\n)\\|\\s*${escapeRegExp(name)}\\s*=\\s*([^\\n]+)`, "i").exec(body);
  return match?.[1]?.trim();
}

function cleanSearchSnippet(snippet: string | undefined): string | undefined {
  if (!snippet) {
    return undefined;
  }

  return snippet.replace(/<[^>]+>/g, "").replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();
}

function normalizeTitle(value: string): string {
  return value.toLowerCase().replace(/[_\s]+/g, " ").trim();
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!value || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(min, Math.min(Math.floor(value), max));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
