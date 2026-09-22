# Hypixel SkyBlock MCP

An AI-facing Model Context Protocol server for Hypixel SkyBlock data. Its 23 tools cover profiles, progression, inventory/storage, Bazaar and auctions, upgrade costs, net worth, Bingo, and configured wiki sources. Results distinguish API observations, estimates, missing data, and incomplete pricing so an assistant can give grounded advice.

## Requirements

- Node.js 22 or newer
- A Hypixel API key for private/profile endpoints

Get a key from the [Hypixel Developer Dashboard](https://developer.hypixel.net/) and provide it as `HYPIXEL_API_KEY`.

## Setup

Add the server to your MCP client config. The package ships a `hypixel-skyblock-mcp` binary, so `npx` can run it without a manual install:

```json
{
  "mcpServers": {
    "hypixel-skyblock": {
      "command": "npx",
      "args": ["-y", "hypixel-skyblock-mcp"],
      "env": {
        "HYPIXEL_API_KEY": "your-key"
      }
    }
  }
}
```

See [`.env.example`](.env.example) for the full list of supported environment variables (cache TTL, request timeout, optional lowest-BIN source).

### Running from source

```bash
npm ci
npm run build
node dist/server.js   # reads HYPIXEL_API_KEY from the environment
```

### Development

```bash
npm test          # run the unit tests
npm run coverage  # run tests + enforce coverage thresholds
npm run smoke     # exercise the compiled server over real MCP stdio
npm run check     # build + coverage + stdio smoke (also before publish)
```

GitHub Actions runs the build, coverage gate, and stdio smoke check on Node 22 and
24 (`.github/workflows/ci.yml`). Tests use realistic fixtures and mocked HTTP
responses; they do not need an API key. The coverage gate includes data logic,
HTTP/cache behavior, wiki integration, pricing/net-worth, and MCP registration.
Profile and audit workflows also have integration tests. A separate smoke check
starts the compiled CLI and verifies initialization, tool discovery, structured
results, errors, and shutdown. The build uses portable Node filesystem operations.

Publishing is automated (`.github/workflows/publish.yml`): creating a GitHub
Release whose tag matches the `package.json` version publishes the package to
npm with provenance. Authentication uses npm
[Trusted Publishing (OIDC)](https://docs.npmjs.com/trusted-publishers/), so no
`NPM_TOKEN` secret is required — configure a Trusted Publisher for this repo and
workflow in the package's npm settings instead.

## Tools

### Player & profiles

- `resolve_player`: username/UUID normalization through Mojang.
- `hypixel_player`: network status, rank, login times, karma, and selected stats.
- `skyblock_profiles`: compact list of a player's SkyBlock profiles.
- `skyblock_profile`: one profile's AI-readable context with skills, progression, slayers, dungeon classes/runs, pet levels/details, collections, essence, accessories, trophy fish, Jacob contest summaries, and optional decoded inventories.

### Inventories & storage

- `skyblock_inventory`: decode wardrobe, armor, equipment, ender chest, backpacks, vault, sacks, bags, and loadouts.
- `skyblock_storage`: **merged storage search** across backpacks, ender chest, vault, sacks, and bags with item grouping and sack totals.

### Progression & guides

- `skyblock_audit`: compact audit with official skill levels, **full HOTM/HOTF perk trees**, minions, bestiary, crimson isle, rift, essence, gear/loadouts (including **essence cost to finish starring equipped gear**, priced live), accessories, ranked gaps, and next actions.
- `skyblock_guide_context`: profile plus mayor and Bazaar economy signals for tailored advice.
- `skyblock_upgrade_advisor`: rank supported star and accessory upgrades by estimated coin cost, with budget filtering, pricing completeness, and explicit unsupported-source reasons. This is not a stat-gain optimizer; unknown-cost upgrades remain descriptive.

### World systems

- `skyblock_museum`: museum donations and value summary.
- `skyblock_garden`: garden plots, commissions, and composter data.
- `skyblock_bingo`: a player's event history and progress matched against current event goals when available.

### Economy & resources

- `skyblock_networth`: estimate a profile's net worth from liquid coins, decoded inventory/storage holdings, sacks, and supported item modifiers, priced with live Bazaar data. Returns a total, per-section breakdown, modifier breakdown, top items by value, and a pricing-coverage report.
- `skyblock_item`: look up an item by ID/name for official metadata and Bazaar or configured lowest-BIN prices. Metadata remains available during pricing outages. `includeWiki: true` adds configured wiki context or an explicit retirement/unavailability result. Ambiguous searches return candidate IDs, and in-game names resolve to canonical IDs.
- `skyblock_resource`: items, skills, collections, election/mayor, bingo, or news.
- `skyblock_wiki_search`: search a configured MediaWiki source; see wiki availability below.
- `skyblock_wiki_page`: fetch a page with source attribution, revision time, redirects, and readable section summaries.
- `skyblock_bazaar`: Bazaar prices, volumes, and spread signals.
- `skyblock_auctions`: active pages, ended auctions, or keyed lookups.
- `skyblock_essence_costs`: exact essence, coin, and material cost for essence-funded stars on a dungeon/crimson item by SkyBlock ID, with an optional live-Bazaar coin estimate. Master Star items are not priced; higher targets are clamped to the bundled table with an explanatory note. Returns `found: false` with suggestions for unknown or non-upgradeable IDs.

### Utilities

- `decode_skyblock_nbt`: decode a SkyBlock NBT payload.
- `cache_clear`: clear Hypixel, Mojang, and wiki caches, including invalidating pending cache writes.
- `server_status`: inspect version, configuration availability, and cache usage without network requests or credential disclosure.

The server also exposes the `skyblock://guide` resource and a `review_profile`
prompt (required `username`, optional `focus`). Tool responses carry JSON text and
matching `structuredContent`; execution failures set MCP `isError: true`. Tool
annotations distinguish external reads, local decoding, and cache mutation.

## Wiki availability

Hypixel [retired its official wiki on July 21, 2026](https://hypixel.net/threads/end-of-the-official-hypixel-wiki-july-2026.6112020/).
The default wiki tools return `available: false`, `status: "retired"`, and the
announcement URL without requesting that service. To use another MediaWiki
installation, set `SKYBLOCK_WIKI_BASE` to its base URL (with an `/api.php` endpoint).
Replacement results explicitly carry `source: "configured_mediawiki"` and
`official: false`. No community provider is silently selected or endorsed.

## HOTM, HOTF, and storage

**HOTM (Heart of the Mountain)** is summarized in `member.progression.hotm` and `skyblock_audit`:

- HOTM level from reported XP, powder totals, crystal states, selected ability
- Core of the Mountain perk level reported separately from HOTM level
- Full unlocked perk list with human-readable names

**HOTF (Heart of the Forest)** is summarized in `member.progression.hotf`:

- Forest Whispers balance and spend
- Unlocked foraging perks and selected ability

**Storage** is best accessed through `skyblock_storage`:

```json
{ "username": "Ventoy", "search": "enchanted diamond" }
```

```json
{
  "username": "Ventoy",
  "skyblockIds": ["DIVAN_HELMET", "DIVAN_CHESTPLATE"],
  "sectionTypes": ["backpack", "ender_chest", "personal_vault"]
}
```

`skyblock_inventory` remains the tool for raw per-section NBT when you need slot-level detail.
NBT input is bounded to 4 MiB of base64 text and 16 MiB after gzip decompression.
Malformed sections are reported as failures, and truncated scans are marked;
incomplete accessory bags do not produce claims that an upgrade is missing.

## Player ratings & metrics

`skyblock_profile` (per member) and `skyblock_audit` (`ratings`) expose the headline numbers players compare:

- **Skill average** (and fractional "true" average) over the eight counted skills: Farming, Mining, Combat, Foraging, Fishing, Enchanting, Alchemy, Taming.
- **Total slayer XP** and summed slayer levels, plus per-boss XP/level.
- **Catacombs level**, **magical power**, and **SkyBlock level**.

`skyblock_audit` and `skyblock_guide_context` also include a compact **mayor** summary: the active mayor, special-mayor flag, active perks, and the ongoing election leaderboard.

## Net worth

`skyblock_networth` prices a profile from:

- **Liquid coins** (purse + bank).
- **Items** in decoded inventory, ender chest, backpacks, personal vault, wardrobe, armor, equipment, and bags, priced by SkyBlock ID via the **Bazaar**.
- **Sacks**, priced via the Bazaar.

Physical items repeated across inventory/wardrobe views are deduplicated by their
item UUID, not their SkyBlock ID. Standalone single-enchantment books resolve to
their actual Bazaar product. Coverage reports failed/omitted sections, unpriced
and unidentified items, sack pricing, and missing balances. `complete` applies
only to the supported holdings; pets, museum holdings, and auction/Bazaar escrow
remain excluded. The bank balance belongs to the co-op, not solely the selected
member. A reported total is the sum of known priced holdings, not proof of the
player's complete wealth.

On top of the **base SkyBlock-ID price**, `skyblock_networth` adds **modifier value** for enchantments, hot potato/fuming books, recombobulators, essence/master stars, socketed gemstones, and reforge stones (set `includeModifiers: false` to disable). Each modifier is valued at the [SkyHelper-Networth](https://github.com/Altpapier/SkyHelper-Networth) "application worth" fraction of the live Bazaar price of the component (e.g. enchantments at 85%, essence at 75%, gemstones and reforge stones at 100%), and essence/master-star costs come from the official items resource's `upgrade_costs`. The response reports `items.modifiers` (total, `byType` breakdown, and `unpricedComponents`).

The modifier categories above are the ones currently modelled. SkyHelper values several more that this server does **not** yet add, so `total` is a conservative estimate for heavily upgraded items: gemstone slot-unlock costs, runes, dyes, pet items/pet levels, art of war/peace, power scrolls, and other cosmetic or upgrade consumables are excluded.

Modifier value is only added to items that already have a base price, so auction-only gear is undervalued unless a lowest-BIN source is configured. Read the `coverage` report (`pricedPercent`) to see how much of the profile could be priced, and treat `total` as an estimate.

Auction-only items are priced only when an external lowest-BIN source is configured via the `SKYBLOCK_LOWEST_BIN_URL` environment variable (a JSON map of `{ SKYBLOCK_ID: price }`, e.g. a Moulberry-style lowest-BIN dump). Bazaar prices always take precedence over that source. Use `priceBasis` to switch between `buy` (market/replacement value, default) and `sell` (liquidation value).

## Notes

Hypixel profile data depends on each player's in-game API settings. Missing fields
stay unknown, with privacy/coverage notes. Audits skip recommendations that require
unavailable skills, magical power, slayer claims, or inventory data. Explicit
profile/member selections that do not match return an error, rather than choosing
a different profile or co-op member. Optional economy/mayor failures leave the
profile audit usable and produce warnings.

Market results distinguish HTTP retrieval time from upstream snapshot time.
`freshness.ageBasis` explains which timestamp is available; external price maps
without snapshot timestamps have unknown age. Missing essence/material prices
produce `pricingComplete: false`, `pricedSubtotalCoins`, and missing-component
details; they never produce a complete upgrade-cost estimate.

Skill levels use Hypixel's official `/v2/resources/skyblock/skills` tables (bundled in `src/skill-tables.json`). SkyBlock level uses the flat 100-XP-per-level formula, pet levels use the official per-rarity XP tables (Golden/Jade/Rose Dragons cap at level 200), and Garden level uses the real Garden XP table (15 levels, capping at 60,120 XP).

Essence upgrade costs (`skyblock_essence_costs`) come from the NotEnoughUpdates `essencecosts.json` constants (bundled in `src/essence-costs.json`). The dataset covers essence-funded stars (1–5 for dungeon gear, up to 10 for crimson/kuudra gear); Master Stars applied with Master Star items are noted but not priced.

For profile reviews, prefer `skyblock_audit` over `skyblock_guide_context` when you want compact gaps and next actions.

The server uses the official Hypixel Public API v2. Keyed endpoints use the
`API-Key` header and report rate-limit headers. Transient failures retry with
bounded backoff; identical concurrent requests share one fetch. Failed responses
are not cached. Cache sizes, timeouts, and retry counts are bounded.

Bundled game tables and heuristic advice have limited scope and may need updates
as the game changes. Reforge/enchant/HOTM/pet optimization and full pet/cosmetic
valuation are not implemented; the upgrade advisor reports these limitations.
