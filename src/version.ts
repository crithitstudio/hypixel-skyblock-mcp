import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FALLBACK_VERSION = "0.0.0";

/**
 * Reads the package version from package.json at runtime so the MCP server
 * identity and the outbound User-Agent always match the published package,
 * instead of a hardcoded string that silently drifts on every release.
 *
 * package.json sits one directory above the compiled module (dist/version.js)
 * and above the source module (src/version.ts), and npm always ships it, so a
 * "../package.json" lookup resolves in both dev and published installs. Any
 * failure falls back to a sentinel rather than crashing server startup.
 */
function readVersion(): string {
  try {
    const packageJsonUrl = new URL("../package.json", import.meta.url);
    const raw = readFileSync(fileURLToPath(packageJsonUrl), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : FALLBACK_VERSION;
  } catch {
    return FALLBACK_VERSION;
  }
}

export const VERSION = readVersion();
