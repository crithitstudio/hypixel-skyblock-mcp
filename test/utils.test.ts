import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  compactObject,
  createTextResult,
  dashedUuid,
  freshnessFromMeta,
  freshnessFromTimestamp,
  getPath,
  isRecord,
  looksLikeUuid,
  normalizeUuid,
  numberOrZero,
  parseEnvInteger,
  percent,
  pickPaths,
  redactApiKey,
  sortByNumeric,
  stripMinecraftFormatting,
  takeEntries
} from "../src/utils.js";

describe("type guards", () => {
  it("distinguishes records, arrays, strings, numbers, booleans", () => {
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([1, 2])).toBe(false);
    expect(isRecord(null)).toBe(false);

    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asRecord([1])).toBeUndefined();

    expect(asArray([1])).toEqual([1]);
    expect(asArray("x")).toBeUndefined();

    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();

    expect(asNumber(3)).toBe(3);
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber("3")).toBeUndefined();

    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(0)).toBeUndefined();
  });
});

describe("string + uuid helpers", () => {
  it("strips Minecraft formatting codes", () => {
    expect(stripMinecraftFormatting("§aGreen §lBold")).toBe("Green Bold");
  });

  it("normalizes and re-dashes uuids", () => {
    const dashed = "12345678-90ab-cdef-1234-567890abcdef";
    expect(normalizeUuid(dashed)).toBe("1234567890abcdef1234567890abcdef");
    expect(dashedUuid("1234567890abcdef1234567890abcdef")).toBe(dashed);
    // Non-uuid input is returned unchanged.
    expect(dashedUuid("not-a-uuid")).toBe("not-a-uuid");
    expect(looksLikeUuid(dashed)).toBe(true);
    expect(looksLikeUuid("nope")).toBe(false);
  });
});

describe("object helpers", () => {
  it("compactObject drops undefined, null, empty arrays and empty records", () => {
    expect(
      compactObject({ a: 1, b: undefined, c: null, d: [], e: {}, f: [1], g: { x: 1 } })
    ).toEqual({ a: 1, f: [1], g: { x: 1 } });
  });

  it("takeEntries limits and tolerates undefined", () => {
    expect(takeEntries({ a: 1, b: 2, c: 3 }, 2)).toEqual({ a: 1, b: 2 });
    expect(takeEntries(undefined, 5)).toEqual({});
  });

  it("getPath and pickPaths traverse nested records", () => {
    const obj = { a: { b: { c: 7 } } };
    expect(getPath(obj, ["a", "b", "c"])).toBe(7);
    expect(getPath(obj, ["a", "x", "c"])).toBeUndefined();
    expect(getPath(obj, ["a", "b", "c", "d"])).toBeUndefined();
    expect(pickPaths(obj, { val: ["a", "b", "c"], missing: ["a", "z"] })).toEqual({ val: 7 });
  });
});

describe("number helpers", () => {
  it("numberOrZero and percent", () => {
    expect(numberOrZero(5)).toBe(5);
    expect(numberOrZero("x")).toBe(0);
    expect(percent(1, 4)).toBe(25);
    expect(percent(1, 0)).toBeUndefined();
    expect(percent(Number.NaN, 4)).toBeUndefined();
  });

  it("sortByNumeric pushes undefined selectors to the end and honors direction", () => {
    const data = [{ v: 1 }, { v: 3 }, { v: undefined }, { v: 2 }];
    expect(sortByNumeric(data, (d) => d.v).map((d) => d.v)).toEqual([3, 2, 1, undefined]);
    expect(sortByNumeric(data, (d) => d.v, "asc").map((d) => d.v)).toEqual([1, 2, 3, undefined]);
  });
});

describe("env + output helpers", () => {
  afterEach(() => {
    delete process.env.__TEST_INT__;
  });

  it("parseEnvInteger falls back on missing/invalid values", () => {
    expect(parseEnvInteger("__TEST_INT__", 42)).toBe(42);
    process.env.__TEST_INT__ = "100";
    expect(parseEnvInteger("__TEST_INT__", 42)).toBe(100);
    process.env.__TEST_INT__ = "notanumber";
    expect(parseEnvInteger("__TEST_INT__", 42)).toBe(42);
  });

  it("createTextResult wraps strings and serializes objects", () => {
    expect(createTextResult("hi").content[0].text).toBe("hi");
    expect(createTextResult({ a: 1 }).content[0].text).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  it("redactApiKey masks key query params only", () => {
    expect(redactApiKey("https://api/x?key=secret&page=1")).toBe("https://api/x?key=<redacted>&page=1");
    expect(redactApiKey("https://api/x?page=1")).toBe("https://api/x?page=1");
  });
});

describe("freshnessFromMeta", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes data age and omits a warning when fresh", () => {
    const now = Date.parse("2026-06-28T00:00:30.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fresh = freshnessFromMeta({ fetchedAt: "2026-06-28T00:00:00.000Z", cached: true, source: "x" }, 60);
    expect(fresh.dataAgeSeconds).toBe(30);
    expect(fresh.cached).toBe(true);
    expect(fresh.staleWarning).toBeUndefined();
  });

  it("sets a staleWarning once age exceeds the threshold", () => {
    const now = Date.parse("2026-06-28T00:02:00.000Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    const stale = freshnessFromMeta({ fetchedAt: "2026-06-28T00:00:00.000Z", cached: false, source: "x" }, 60);
    expect(stale.dataAgeSeconds).toBe(120);
    expect(stale.staleWarning).toContain("120s");
  });

  it("returns null age (no crash) when the timestamp is missing or unparseable", () => {
    const result = freshnessFromMeta({ fetchedAt: "", cached: false, source: "x" }, 60);
    expect(result.dataAgeSeconds).toBeNull();
    expect(result.staleWarning).toBeUndefined();
  });

  it("attaches a clarifying note when provided", () => {
    const result = freshnessFromMeta({ fetchedAt: "2026-06-28T00:00:00.000Z", cached: false, source: "x" }, 60, "metadata only");
    expect(result.note).toBe("metadata only");
  });

  it("freshnessFromTimestamp returns undefined without a timestamp", () => {
    expect(freshnessFromTimestamp(undefined, false, 60)).toBeUndefined();
    expect(freshnessFromTimestamp("2026-06-28T00:00:00.000Z", true, 60)?.cached).toBe(true);
  });
});
