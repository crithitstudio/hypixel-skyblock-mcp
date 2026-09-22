import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as wiki from "../src/wiki.js";

function pageResponse(title = "Hyperion"): Response {
  return Response.json({ query: { pages: [{
    pageid: 42, title, fullurl: `https://community.test/${title}`,
    revisions: [{ timestamp: "2026-09-21T00:00:00Z", slots: { main: { content: "{{Item Page\n|summary=A useful sword.\n|obtaining=\n* Craft it using eight fragments.\n* Buy it at auction.\n|usage=Fight enemies.\n}}" } } }]
  }] } });
}

describe("MediaWiki integration", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("SKYBLOCK_WIKI_BASE", "https://community.test");
    wiki.clearWikiCache();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(["", "https://wiki.hypixel.net/"])("reports the official wiki retirement without requesting its dead endpoint (%s)", async (base) => {
    vi.stubEnv("SKYBLOCK_WIKI_BASE", base);
    const page = await wiki.getOfficialWikiPage({ title: "Hyperion" });
    expect(page).toMatchObject({ found: false, available: false, status: "retired", source: "official_hypixel_skyblock_wiki" });
    expect(page.announcementUrl).toContain("end-of-the-official-hypixel-wiki");
    expect(await wiki.searchOfficialWiki("Hyperion")).toMatchObject({ available: false, status: "retired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("labels configured sources accurately and resolves aliases through MediaWiki redirects", async () => {
    fetchMock.mockResolvedValueOnce(pageResponse());
    const result = await wiki.getOfficialWikiPage({ title: "Hype", includeRaw: true });
    expect(result).toMatchObject({ found: true, source: "configured_mediawiki", official: false, title: "Hyperion" });
    expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("redirects")).toBe("1");
    expect((result.sections as Record<string, string>).obtaining).toContain("eight fragments");
    expect((result.sections as Record<string, string>).obtaining).toContain("Buy it at auction");
  });

  it("retains the original fetchedAt on cache hits and bounds cache growth", async () => {
    vi.stubEnv("SKYBLOCK_WIKI_CACHE_MAX_ENTRIES", "2");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-22T00:00:00Z"));
    fetchMock.mockImplementation(async () => pageResponse());
    const first = await wiki.getOfficialWikiPage({ title: "First" });
    vi.setSystemTime(new Date("2026-09-22T00:01:00Z"));
    const cached = await wiki.getOfficialWikiPage({ title: "First" });
    expect(cached.meta).toMatchObject({ cached: true, fetchedAt: (first.meta as Record<string, unknown>).fetchedAt });
    await wiki.getOfficialWikiPage({ title: "Second" });
    await wiki.getOfficialWikiPage({ title: "Third" });
    expect(wiki.wikiCacheStats()).toMatchObject({ entries: 2, maxEntries: 2 });
    expect(wiki.clearWikiCache()).toBe(2);
    expect(wiki.wikiCacheStats().entries).toBe(0);
  });

  it("does not cache MediaWiki error envelopes", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { code: "ratelimited", info: "Too many requests" } }))
      .mockResolvedValueOnce(pageResponse());
    await expect(wiki.getOfficialWikiPage({ title: "Hyperion" })).rejects.toThrow(/ratelimited/);
    expect((await wiki.getOfficialWikiPage({ title: "Hyperion" })).found).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([null, {}, { query: {} }, { query: { pages: [{}] } }])("rejects malformed pages instead of claiming success: %j", async (body) => {
    fetchMock.mockResolvedValueOnce(Response.json(body));
    await expect(wiki.getOfficialWikiPage({ title: "Hyperion" })).rejects.toThrow(/invalid.*response/i);
  });

  it("coalesces wiki requests without letting a cache clear resurrect old entries", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }))
      .mockImplementation(async () => pageResponse("New"));
    const first = wiki.getOfficialWikiPage({ title: "Same" });
    const second = wiki.getOfficialWikiPage({ title: "Same" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    wiki.clearWikiCache();
    expect((await wiki.getOfficialWikiPage({ title: "Same" })).title).toBe("New");
    finish(pageResponse("Old"));
    await Promise.all([first, second]);
    expect((await wiki.getOfficialWikiPage({ title: "Same" })).title).toBe("New");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns no match for missing pages and empty search results", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ query: { pages: [{ title: "Missing", missing: true }] } }))
      .mockResolvedValueOnce(Response.json({ query: { search: [], searchinfo: { totalhits: 0 } } }));
    expect(await wiki.getOfficialWikiPage({ title: "Missing" })).toMatchObject({ found: false, source: "configured_mediawiki", official: false });
  });

  it("supports MediaWiki installations under a base path", async () => {
    vi.stubEnv("SKYBLOCK_WIKI_BASE", "https://community.test/w/");
    fetchMock.mockResolvedValueOnce(pageResponse());
    await wiki.getOfficialWikiPage({ title: "Hyperion" });
    expect(new URL(fetchMock.mock.calls[0][0]).pathname).toBe("/w/api.php");
  });

  it("re-fetches expired wiki entries and isolates metadata returned to callers", async () => {
    vi.useFakeTimers();
    vi.stubEnv("SKYBLOCK_WIKI_CACHE_TTL_MS", "1000");
    fetchMock.mockImplementation(async () => pageResponse());
    const first = await wiki.getOfficialWikiPage({ title: "Hyperion" });
    (first.meta as Record<string, unknown>).fetchedAt = "corrupted";
    expect((await wiki.getOfficialWikiPage({ title: "Hyperion" })).meta).not.toMatchObject({ fetchedAt: "corrupted" });
    await vi.advanceTimersByTimeAsync(1_001);
    expect((await wiki.getOfficialWikiPage({ title: "Hyperion" })).meta).toMatchObject({ cached: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports non-JSON, HTTP, and inaccessible revision errors clearly", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>challenge</html>"))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json({ query: { pages: [{ title: "Hyperion" }] } }));
    await expect(wiki.getOfficialWikiPage({ title: "Hyperion" })).rejects.toThrow(/JSON/);
    await expect(wiki.getOfficialWikiPage({ title: "Hyperion" })).rejects.toThrow(/503/);
    await expect(wiki.getOfficialWikiPage({ title: "Hyperion" })).rejects.toThrow(/revision content/);
    expect(wiki.wikiCacheStats().entries).toBe(0);
  });
});
