import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The optional path allows the same check to verify an extracted npm tarball.
const entry = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../dist/server.js", import.meta.url));
const client = new Client({ name: "package-smoke", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: { HYPIXEL_API_KEY: "", HYPIXEL_API_TOKEN: "" },
  stderr: "pipe"
});
let stderr = "";
transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
const deadline = setTimeout(() => {
  console.error("MCP smoke check exceeded 15 seconds.");
  void transport.close().finally(() => process.exit(1));
}, 15_000);

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert(tools.some((tool) => tool.name === "skyblock_bingo"));
  const identity = await client.callTool({ name: "resolve_player", arguments: { uuid: "12345678123412341234123456789abc" } });
  assert.equal(identity.structuredContent?.uuid, "12345678123412341234123456789abc");
  const failure = await client.callTool({ name: "skyblock_profiles", arguments: { uuid: "12345678123412341234123456789abc" } });
  assert.equal(failure.isError, true);
  assert.match(String(failure.structuredContent?.error), /HYPIXEL_API_KEY/);
  const status = await client.callTool({ name: "server_status", arguments: {} });
  assert.equal(status.structuredContent?.hasApiKey, false);
  assert.equal(stderr, "");
  console.log(`MCP stdio smoke passed: ${tools.length} tools, structured output, actionable errors, diagnostics.`);
} finally {
  await client.close();
  clearTimeout(deadline);
}
