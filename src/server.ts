#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HypixelApiError, McpUserError } from "./errors.js";
import { getSkyblockAudit } from "./audit.js";
import { getEssenceUpgradeCost } from "./essence-costs.js";
import { HypixelClient } from "./hypixelClient.js";
import { lookupItem } from "./item-lookup.js";
import { getSkyblockNetworth } from "./networth.js";
import { decodeBase64Nbt, extractInventoryItems } from "./nbt.js";
import {
  getAuctions,
  getBazaar,
  getGuideContext,
  getHypixelPlayer,
  getSkyblockGardenContext,
  getSkyblockInventoryContext,
  getSkyblockMuseumContext,
  getSkyblockProfileContext,
  getSkyblockResource,
  getSkyblockStorageContext,
  listSkyblockProfiles,
  resolvePlayer
} from "./skyblock.js";
import { createTextResult } from "./utils.js";
import { VERSION } from "./version.js";
import { getOfficialWikiPage, searchOfficialWiki } from "./wiki.js";

const server = new McpServer({
  name: "hypixel-skyblock",
  version: VERSION
});
const client = new HypixelClient();

const playerInput = {
  username: z.string().min(1).optional().describe("Minecraft username. Use this when the user gives a name."),
  uuid: z.string().min(1).optional().describe("Minecraft UUID, dashed or undashed.")
};

const profileSelectionInput = {
  profileId: z.string().min(1).optional().describe("Specific SkyBlock profile UUID."),
  profileName: z.string().min(1).optional().describe("Cute profile name, for example Apple, Lemon, or Coconut."),
  selectedOnly: z.boolean().default(true).describe("Prefer the selected profile when multiple profiles exist."),
  memberUsername: z.string().min(1).optional().describe("Coop member username to inspect. Defaults to requested player."),
  memberUuid: z.string().min(1).optional().describe("Coop member UUID to inspect. Defaults to requested player.")
};

const inventorySectionTypes = z
  .array(z.string().min(1))
  .max(32)
  .optional()
  .describe(
    "Filter decoded inventory sections by type. Common values: inventory, wardrobe, armor, equipment, ender_chest, backpack, accessory_bag, potion_bag, fishing_bag, quiver, personal_vault, sack, loadout, container, unknown. Omit or include all for all inventory-like sections."
  );

const inventorySectionPaths = z
  .array(z.string().min(1))
  .max(32)
  .optional()
  .describe("Filter decoded inventory sections by case-insensitive path substring, for example wardrobe_contents or backpack_contents.");

const profileInventoryDecodeInput = {
  maxItemsPerInventory: z.number().int().min(1).max(500).default(80),
  maxInventorySections: z.number().int().min(1).max(200).default(24),
  inventorySectionTypes,
  inventorySectionPaths,
  includeAllNbtData: z.boolean().default(false).describe("Search every base64 NBT payload on the member, not only inventory-like paths."),
  includeRawNbt: z.boolean().default(false).describe("Include simplified raw NBT for decoded sections. Very large output."),
  includeItemDetails: z.boolean().default(false).describe("Include extra compact ExtraAttributes fields on decoded items."),
  maxLoreLines: z.number().int().min(0).max(50).default(8)
};

server.registerTool(
  "resolve_player",
  {
    title: "Resolve Minecraft Player",
    description: "Resolve a Minecraft username or UUID into normalized UUID forms for Hypixel tools.",
    inputSchema: playerInput
  },
  async (input) => runTool(() => resolvePlayer(client, input))
);

server.registerTool(
  "skyblock_profiles",
  {
    title: "List SkyBlock Profiles",
    description:
      "List a player's SkyBlock profiles with compact member metadata. Requires HYPIXEL_API_KEY and respects the player's API privacy settings.",
    inputSchema: {
      ...playerInput,
      includeRaw: z.boolean().default(false).describe("Include raw Hypixel profile objects. Large output.")
    }
  },
  async (input) => runTool(() => listSkyblockProfiles(client, input))
);

server.registerTool(
  "skyblock_profile",
  {
    title: "Get SkyBlock Profile Context",
    description:
      "Fetch one SkyBlock profile and return compact AI-readable member context: skills, slayers, dungeons, pets, collections, currencies, accessories, and optional decoded inventories.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput,
      decodeInventories: z.boolean().default(true).describe("Decode base64 gzipped NBT inventory sections when available."),
      ...profileInventoryDecodeInput,
      includeMuseum: z.boolean().default(false).describe("Fetch museum data for the selected profile."),
      includeGarden: z.boolean().default(false).describe("Fetch garden data for the selected profile."),
      includeRawMember: z.boolean().default(false).describe("Include the raw selected member object. Large output."),
      includeRawProfile: z.boolean().default(false).describe("Include the raw selected profile object. Large output.")
    }
  },
  async (input) => runTool(() => getSkyblockProfileContext(client, input))
);

server.registerTool(
  "skyblock_inventory",
  {
    title: "Get SkyBlock Inventory Sections",
    description:
      "Fetch and decode inventory-like NBT sections for one SkyBlock profile, including wardrobe, armor, equipment, ender chest, backpacks, vault, and bags. Use filters to keep output focused.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput,
      sectionTypes: inventorySectionTypes,
      sectionPaths: inventorySectionPaths,
      maxSections: z.number().int().min(1).max(200).default(40),
      maxItemsPerSection: z.number().int().min(1).max(500).default(100),
      includeAllNbtData: z.boolean().default(false).describe("Search every base64 NBT payload on the member, not only inventory-like paths."),
      includeRawNbt: z.boolean().default(false).describe("Include simplified raw NBT for decoded sections. Very large output."),
      includeItemDetails: z.boolean().default(true).describe("Include extra compact ExtraAttributes fields on decoded items."),
      maxLoreLines: z.number().int().min(0).max(50).default(12),
      includeRawMember: z.boolean().default(false).describe("Include the raw selected member object. Very large output.")
    }
  },
  async (input) => runTool(() => getSkyblockInventoryContext(client, input))
);

server.registerTool(
  "skyblock_storage",
  {
    title: "Search SkyBlock Storage",
    description:
      "Decode and merge items across backpacks, ender chest, personal vault, sacks, bags, and inventory. Returns grouped item counts, sack totals, and optional per-section detail.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput,
      sectionTypes: inventorySectionTypes,
      sectionPaths: inventorySectionPaths,
      search: z.string().min(1).optional().describe("Case-insensitive search across item names and SkyBlock IDs."),
      skyblockIds: z.array(z.string().min(1)).max(50).optional().describe("Only include these SkyBlock item IDs."),
      groupBySkyblockId: z.boolean().default(true).describe("Merge duplicate item IDs across storage locations."),
      maxSections: z.number().int().min(1).max(200).default(120),
      maxItemsPerSection: z.number().int().min(1).max(500).default(120),
      itemLimit: z.number().int().min(1).max(1000).default(250),
      includeItemDetails: z.boolean().default(true),
      includeSections: z.boolean().default(false).describe("Include raw decoded sections. Large output.")
    }
  },
  async (input) => runTool(() => getSkyblockStorageContext(client, input))
);

server.registerTool(
  "hypixel_player",
  {
    title: "Get Hypixel Player Status",
    description:
      "Fetch Hypixel network player data: online status, rank, login times, karma, and selected network stats. Requires HYPIXEL_API_KEY.",
    inputSchema: playerInput
  },
  async (input) => runTool(() => getHypixelPlayer(client, input))
);

server.registerTool(
  "skyblock_museum",
  {
    title: "Get SkyBlock Museum",
    description: "Fetch museum donations and value summary for a SkyBlock profile member.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput
    }
  },
  async (input) => runTool(() => getSkyblockMuseumContext(client, input))
);

server.registerTool(
  "skyblock_garden",
  {
    title: "Get SkyBlock Garden",
    description: "Fetch garden plot, commission, and composter data for a SkyBlock profile.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput
    }
  },
  async (input) => runTool(() => getSkyblockGardenContext(client, input))
);

server.registerTool(
  "skyblock_audit",
  {
    title: "Audit SkyBlock Profile",
    description:
      "Return a compact profile audit with computed levels, HOTM/HOTF trees, progression gaps, gear/loadout summaries, accessory analysis, and prioritized next actions.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput,
      focus: z
        .array(z.string().min(1))
        .max(12)
        .optional()
        .describe(
          "Audit focus areas: mining, foraging, farming, dungeons, slayers, money, combat, pets, accessories, skills, progression."
        ),
      includeEconomy: z.boolean().default(true),
      includeMayor: z.boolean().default(true)
    }
  },
  async (input) => runTool(() => getSkyblockAudit(client, input))
);

server.registerTool(
  "skyblock_networth",
  {
    title: "Estimate SkyBlock Net Worth",
    description:
      "Estimate a profile's net worth from liquid coins, decoded inventory/storage holdings, sacks, and supported item modifiers, priced with live Bazaar data (and an optional external lowest-BIN source for auction items). Returns a total, per-section breakdown, top items by value, modifier breakdown, and pricing coverage.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput,
      priceBasis: z
        .enum(["buy", "sell"])
        .default("buy")
        .describe("buy = market/replacement value (insta-buy), sell = liquidation value (insta-sell)."),
      includeAuctionPrices: z
        .boolean()
        .default(true)
        .describe("Use the configured external lowest-BIN source for auction-only items when available."),
      includeSacks: z.boolean().default(true),
      includeModifiers: z
        .boolean()
        .default(true)
        .describe(
          "Add modifier value (enchantments, hot potato books, recombobulator, essence/master stars, gemstones, reforge stones) on top of base item prices."
        ),
      topItems: z.number().int().min(1).max(100).default(20),
      includeUnpriced: z.boolean().default(false).describe("List items that could not be priced. Helps explain coverage gaps.")
    }
  },
  async (input) => runTool(() => getSkyblockNetworth(client, input))
);

server.registerTool(
  "skyblock_guide_context",
  {
    title: "Build SkyBlock Guide Context",
    description:
      "Fetch a profile plus current mayor and economy signals so an AI can write tailored SkyBlock progression advice. Requires HYPIXEL_API_KEY for player/profile data.",
    inputSchema: {
      ...playerInput,
      ...profileSelectionInput,
      goals: z.array(z.string().min(1)).max(12).optional().describe("Guide focus areas, for example mining, farming, dungeons, money."),
      decodeInventories: z.boolean().default(true),
      ...profileInventoryDecodeInput,
      includeEconomy: z.boolean().default(true),
      includeMayor: z.boolean().default(true),
      includeMuseum: z.boolean().default(false),
      includeGarden: z.boolean().default(true)
    }
  },
  async (input) => runTool(() => getGuideContext(client, input))
);

server.registerTool(
  "skyblock_resource",
  {
    title: "Fetch SkyBlock Resource",
    description:
      "Fetch public SkyBlock resources: items, skills, collections, election/mayor, bingo, or news. Supports filtering for item and resource searches.",
    inputSchema: {
      kind: z.enum(["collections", "skills", "items", "election", "bingo", "news"]),
      search: z.string().min(1).optional(),
      ids: z.array(z.string().min(1)).max(100).optional().describe("Item IDs to fetch when kind=items."),
      category: z.string().min(1).optional().describe("Item category filter when kind=items."),
      tier: z.string().min(1).optional().describe("Item tier filter when kind=items."),
      limit: z.number().int().min(1).max(500).default(100),
      includeRaw: z.boolean().default(false)
    }
  },
  async (input) => runTool(() => getSkyblockResource(client, input))
);

server.registerTool(
  "skyblock_bazaar",
  {
    title: "Fetch SkyBlock Bazaar",
    description:
      "Fetch current Bazaar product prices, volumes, and spread signals. Useful for money-making tips and crafting cost checks.",
    inputSchema: {
      productIds: z.array(z.string().min(1)).max(100).optional(),
      search: z.string().min(1).optional(),
      sortBy: z.enum(["margin", "marginPercent", "volume", "movingWeek", "buyPrice", "sellPrice"]).default("movingWeek"),
      limit: z.number().int().min(1).max(200).default(30),
      includeOrders: z.boolean().default(false),
      includeRaw: z.boolean().default(false)
    }
  },
  async (input) => runTool(() => getBazaar(client, input))
);

server.registerTool(
  "skyblock_auctions",
  {
    title: "Fetch SkyBlock Auctions",
    description:
      "Fetch active auction pages, recently ended auctions, or API-key auction lookups by auction, player, or profile. Filters output for AI use.",
    inputSchema: {
      mode: z.enum(["active_page", "ended_recent", "lookup"]).optional(),
      page: z.number().int().min(0).default(0),
      auctionUuid: z.string().min(1).optional(),
      playerUuid: z.string().min(1).optional(),
      playerUsername: z.string().min(1).optional(),
      profileId: z.string().min(1).optional(),
      search: z.string().min(1).optional(),
      tier: z.string().min(1).optional(),
      category: z.string().min(1).optional(),
      binOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(50),
      includeRaw: z.boolean().default(false)
    }
  },
  async (input) => runTool(() => getAuctions(client, input))
);

server.registerTool(
  "skyblock_item",
  {
    title: "Look Up SkyBlock Item",
    description:
      "Look up a single SkyBlock item by ID or name and return its official metadata (tier, category, stats, NPC price, museum/soulbound flags) plus a live value: full Bazaar buy/sell/spread/volume for Bazaar items, or a lowest-BIN price when an external source is configured, otherwise a clear auction-only note. Set includeWiki for official Hypixel SkyBlock Wiki obtaining/usage/upgrading/history context. Ambiguous searches return candidate IDs instead of guessing.",
    inputSchema: {
      itemId: z.string().min(1).optional().describe("Exact SkyBlock item ID, for example HYPERION or ENCHANTED_DIAMOND."),
      search: z.string().min(1).optional().describe("Item name or substring when the exact ID is unknown."),
      includeBazaarOrders: z.boolean().default(false).describe("Include top Bazaar buy/sell order summaries for Bazaar items."),
      priceBasis: z.enum(["buy", "sell"]).default("buy").describe("Price basis used only for the lowest-BIN fallback."),
      maxCandidates: z.number().int().min(1).max(50).default(15).describe("Max candidate IDs to return for an ambiguous search."),
      includeWiki: z.boolean().default(false).describe("Fetch official Hypixel SkyBlock Wiki context for the resolved item."),
      maxWikiSectionChars: z
        .number()
        .int()
        .min(200)
        .max(2_500)
        .default(900)
        .describe("Maximum characters per wiki section when includeWiki is true.")
    }
  },
  async (input) => runTool(() => lookupItem(client, input))
);

server.registerTool(
  "skyblock_wiki_search",
  {
    title: "Search Official SkyBlock Wiki",
    description:
      "Search the official Hypixel SkyBlock Wiki through its MediaWiki API. Use this for item, mechanic, update, NPC, location, and guide-page discovery from first-party wiki data.",
    inputSchema: {
      search: z.string().min(1).describe("Search query, for example Hyperion, Lotus Atoll, or Armor."),
      limit: z.number().int().min(1).max(25).default(10)
    }
  },
  async ({ search, limit }) => runTool(() => searchOfficialWiki(search, { limit }))
);

server.registerTool(
  "skyblock_wiki_page",
  {
    title: "Fetch Official SkyBlock Wiki Page",
    description:
      "Fetch one official Hypixel SkyBlock Wiki page via MediaWiki query/revisions and return cleaned AI-readable section summaries. For item pages, this extracts summary, obtaining, upgrading, usage, history, and trivia when present.",
    inputSchema: {
      title: z.string().min(1).optional().describe("Exact wiki page title, for example Hyperion or Necron's Blade Scrolls."),
      search: z.string().min(1).optional().describe("Fallback wiki search query when title is unknown or missing."),
      includeRaw: z.boolean().default(false).describe("Include raw wikitext. Large and usually unnecessary."),
      maxSectionChars: z.number().int().min(200).max(2_500).default(900)
    }
  },
  async (input) => runTool(() => getOfficialWikiPage(input))
);

server.registerTool(
  "skyblock_essence_costs",
  {
    title: "Calculate Essence Upgrade Cost",
    description:
      "Compute the exact essence, coin, and material cost to star up (or master-star) a dungeon/crimson item by its SkyBlock ID, using authoritative per-star cost data. Optionally prices essence and materials with live Bazaar data for a coin estimate. Returns found=false with suggestions when the item ID is not star-upgradeable or not recognized.",
    inputSchema: {
      itemId: z.string().min(1).describe("Canonical SkyBlock item ID, for example NECRON_CHESTPLATE, HYPERION, or CRIMSON_HELMET."),
      fromStar: z.number().int().min(0).max(15).default(0).describe("Current star level (0 = no stars)."),
      toStar: z.number().int().min(0).max(15).optional().describe("Target star level. Defaults to the item's maximum (includes master stars)."),
      quantity: z.number().int().min(1).max(100).default(1).describe("Number of identical items to upgrade (e.g. a full 4-piece armor set)."),
      priceWithBazaar: z.boolean().default(true).describe("Convert essence and material costs into an estimated coin cost using live Bazaar prices."),
      priceBasis: z
        .enum(["buy", "sell"])
        .default("buy")
        .describe("buy = replacement cost (insta-buy), sell = liquidation value (insta-sell).")
    }
  },
  async (input) => runTool(() => getEssenceUpgradeCost(client, input))
);

server.registerTool(
  "decode_skyblock_nbt",
  {
    title: "Decode SkyBlock NBT",
    description:
      "Decode a Hypixel SkyBlock base64 gzipped NBT inventory/item payload into plain JSON and a compact item list.",
    inputSchema: {
      data: z.string().min(32),
      maxItems: z.number().int().min(1).max(300).default(100),
      includeRaw: z.boolean().default(false)
    }
  },
  async ({ data, maxItems, includeRaw }) =>
    runTool(async () => {
      const decoded = await decodeBase64Nbt(data);
      return {
        items: extractInventoryItems(decoded).slice(0, maxItems),
        raw: includeRaw ? decoded : undefined
      };
    })
);

server.registerTool(
  "cache_clear",
  {
    title: "Clear MCP Cache",
    description: "Clear this MCP server's in-memory Hypixel and Mojang response cache.",
    inputSchema: {}
  },
  async () =>
    runTool(async () => {
      const clearedEntries = client.clearCache();
      return { cleared: true, clearedEntries };
    })
);

async function runTool<T>(operation: () => Promise<T>): Promise<ReturnType<typeof createTextResult>> {
  try {
    return createTextResult(await operation());
  } catch (error) {
    if (error instanceof McpUserError) {
      return createTextResult({ error: error.message });
    }

    if (error instanceof HypixelApiError) {
      return createTextResult({
        error: error.message,
        status: error.status,
        rateLimit: error.rateLimit,
        body: error.body
      });
    }

    return createTextResult({
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
  process.stdin.once("close", () => process.exit(0));

  setInterval(() => undefined, 2_147_483_647);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
