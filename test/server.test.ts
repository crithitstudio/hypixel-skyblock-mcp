import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import * as nbt from "prismarine-nbt";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../src/mcp.js";
import { HypixelClient } from "../src/hypixelClient.js";

const connections: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

async function connect() {
  const server = createMcpServer(new HypixelClient({ apiKey: "", maxRetries: 0 }));
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

afterEach(async () => {
  await Promise.all(connections.splice(0).map(async ({ client, server }) => {
    await client.close();
    await server.close();
  }));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("MCP protocol", () => {
  it("advertises read-only external tools and local cache mutation accurately", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.find((tool) => tool.name === "skyblock_profile")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tools.find((tool) => tool.name === "decode_skyblock_nbt")?.annotations)
      .toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(tools.find((tool) => tool.name === "cache_clear")?.annotations)
      .toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  });

  it("returns matching structured/text results for an exact UUID without network access", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "resolve_player", arguments: { uuid: "12345678-1234-1234-1234-123456789abc" } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ uuid: "12345678123412341234123456789abc" });
    expect(JSON.parse((result.content as Array<{ text: string }>)[0]!.text)).toEqual(result.structuredContent);
  });

  it("accepts valid NBT payloads larger than ordinary identifier limits", async () => {
    const data = nbt.writeUncompressed(nbt.comp({
      i: nbt.list(nbt.comp([{ id: nbt.string("stone"), Count: nbt.byte(1) }])),
      padding: nbt.string("x".repeat(300))
    }) as never).toString("base64");
    expect(data.length).toBeGreaterThan(256);
    const client = await connect();
    const result = await client.callTool({ name: "decode_skyblock_nbt", arguments: { data } });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ itemCount: 1, shownItems: 1, truncated: false });
  });

  it("marks actionable user failures as MCP errors", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "skyblock_profiles", arguments: { uuid: "12345678123412341234123456789abc" } });
    expect(result.isError).toBe(true);
  });

  it("marks returned input failures as errors while preserving legitimate not-found results", async () => {
    const client = await connect();
    for (const name of ["skyblock_item", "skyblock_wiki_page"]) {
      const result = await client.callTool({ name, arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toHaveProperty("error");
    }
    const retired = await client.callTool({ name: "skyblock_wiki_page", arguments: { title: "Hyperion" } });
    expect(retired.isError).not.toBe(true);
    expect(retired.structuredContent).toMatchObject({ found: false, status: "retired" });
  });

  it("rejects malformed identities before fetching upstream", async () => {
    const fetch = vi.fn(() => { throw new Error("Unexpected network request"); });
    vi.stubGlobal("fetch", fetch);
    const client = await connect();
    for (const args of [{ uuid: "bad" }, { username: " " }, { username: "a".repeat(65) }]) {
      expect((await client.callTool({ name: "resolve_player", arguments: args })).isError).toBe(true);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports local status without requesting or disclosing credentials", async () => {
    const client = await connect();
    const result = await client.callTool({ name: "server_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ hasApiKey: false, transport: "stdio" });
    expect(result.structuredContent).toHaveProperty("cache");
  });

  it("keeps diagnostics usable when the optional wiki URL is invalid", async () => {
    vi.stubEnv("SKYBLOCK_WIKI_BASE", "not a URL");
    const client = await connect();
    const result = await client.callTool({ name: "server_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ integrations: { wiki: "invalid_configuration" } });
  });

  it("preserves upstream status in structured MCP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ cause: "Rate limit reached" }), { status: 429 })));
    const client = await connect();
    const result = await client.callTool({ name: "skyblock_bazaar", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: 429, error: "Rate limit reached" });
  });

  it("provides a discoverable workflow resource and profile review prompt", async () => {
    const client = await connect();
    const resources = await client.listResources();
    expect(resources.resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: "skyblock://guide" })]));
    const resource = await client.readResource({ uri: "skyblock://guide" });
    expect(resource.contents[0]).toHaveProperty("text");
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toContain("review_profile");
    const prompt = await client.getPrompt({ name: "review_profile", arguments: { username: "Example", focus: "mining" } });
    expect(prompt.messages[0]?.content).toMatchObject({ type: "text" });
    expect((prompt.messages[0]?.content as { text: string }).text).toContain("Example");
    expect((prompt.messages[0]?.content as { text: string }).text).toContain("mining");
  });
});
