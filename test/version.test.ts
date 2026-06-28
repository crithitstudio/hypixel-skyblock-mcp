import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";

describe("VERSION", () => {
  it("matches the package.json version", () => {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(fileURLToPath(packageJsonUrl), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("looks like a semantic version", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
