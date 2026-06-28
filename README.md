# Hypixel SkyBlock MCP

An AI-facing Model Context Protocol server for Hypixel SkyBlock data. It fetches profile data, public resources, Bazaar prices, auctions, museum/garden data, HOTM/HOTF skill trees, merged storage search, and base64 gzipped NBT inventory payloads, then returns compact JSON that is easier for an AI assistant to use for guides and tips.

## Requirements

- Node.js 20 or newer
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
npm install
npm run build
node dist/server.js   # reads HYPIXEL_API_KEY from the environment
```

### Development

```bash
npm test          # run the unit tests
npm run coverage  # run tests + enforce coverage thresholds
npm run check     # build + test (also runs automatically before publish)
```

GitHub Actions runs the build and the coverage gate on every push and pull
request (`.github/workflows/ci.yml`). The coverage gate (configured in
`vitest.config.ts`) is scoped to the deterministic, pure-logic modules; the
network/orchestration layer that calls the live Hypixel API is verified
manually rather than by unit tests.

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
- `skyblock_profile`: one profile's AI-readable context with skills, progression, slayers, dungeons, pets, collections, essence, accessories, and optional decoded inventories.

### Inventories & storage

- `skyblock_inventory`: decode wardrobe, armor, equipment, ender chest, backpacks, vault, sacks, bags, and loadouts.
- `skyblock_storage`: **merged storage search** across backpacks, ender chest, vault, sacks, and bags with item grouping and sack totals.

### Progression & guides

- `skyblock_audit`: compact audit with official skill levels, **full HOTM/HOTF perk trees**, minions, bestiary, crimson isle, rift, essence, gear/loadouts (including **essence cost to finish starring equipped gear**, priced live), accessories, ranked gaps, and next actions.
- `skyblock_guide_context`: profile plus mayor and Bazaar economy signals for tailored advice.

### World systems

- `skyblock_museum`: museum donations and value summary.
- `skyblock_garden`: garden plots, commissions, and composter data.

### Economy & resources

- `skyblock_networth`: estimate a profile's net worth from liquid coins, decoded inventory/storage holdings, and sacks, priced with live Bazaar data. Returns a total, per-section breakdown, top items by value, and a pricing-coverage report.
- `skyblock_item`: look up one item by ID or name and get official metadata plus a live value (Bazaar buy/sell/spread/volume, lowest-BIN when configured, or a clear auction-only note). Ambiguous searches return candidate IDs, and it resolves in-game names (e.g. "Necron's Chestplate") to canonical IDs.
- `skyblock_resource`: items, skills, collections, election/mayor, bingo, or news.
- `skyblock_bazaar`: Bazaar prices, volumes, and spread signals.
- `skyblock_auctions`: active pages, ended auctions, or keyed lookups.
- `skyblock_essence_costs`: exact essence, coin, and material cost to star up (or master-star) a dungeon/crimson item by SkyBlock ID, with an optional live-Bazaar coin estimate. Returns `found: false` with suggestions for unknown or non-upgradeable IDs.

### Utilities

- `decode_skyblock_nbt`: decode a SkyBlock NBT payload.
- `cache_clear`: clear the in-memory response cache.

## HOTM, HOTF, and storage

**HOTM (Heart of the Mountain)** is summarized in `member.progression.hotm` and `skyblock_audit`:

- HOTM level, powder totals, crystal states, selected ability
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

On top of the **base SkyBlock-ID price**, `skyblock_networth` adds **modifier value** for enchantments, hot potato/fuming books, recombobulators, and essence/master stars (set `includeModifiers: false` to disable). Each modifier is valued at the [SkyHelper-Networth](https://github.com/Altpapier/SkyHelper-Networth) "application worth" fraction of the live Bazaar price of the component (e.g. enchantments at 85%, essence at 75%), and essence/master-star costs come from the official items resource's `upgrade_costs`. The response reports `items.modifiers` (total, `byType` breakdown, and `unpricedComponents`).

The modifier categories above are the ones currently modelled. SkyHelper values several more that this server does **not** yet add, so `total` is a conservative estimate for heavily upgraded items: reforges, gemstones and gemstone slots, runes, dyes, pet items/pet levels, art of war/peace, power scrolls, and other cosmetic or upgrade consumables are excluded.

Modifier value is only added to items that already have a base price, so auction-only gear is undervalued unless a lowest-BIN source is configured. Read the `coverage` report (`pricedPercent`) to see how much of the profile could be priced, and treat `total` as an estimate.

Auction-only items are priced only when an external lowest-BIN source is configured via the `SKYBLOCK_LOWEST_BIN_URL` environment variable (a JSON map of `{ SKYBLOCK_ID: price }`, e.g. a Moulberry-style lowest-BIN dump). Bazaar prices always take precedence over that source. Use `priceBasis` to switch between `buy` (market/replacement value, default) and `sell` (liquidation value).

## Notes

Hypixel profile data depends on each player's in-game API settings. When fields are missing, the MCP returns `privacy` notes so the AI does not overclaim inventory, pet, collection, or skill state.

Skill levels use Hypixel's official `/v2/resources/skyblock/skills` tables (bundled in `src/skill-tables.json`). SkyBlock level uses the flat 100-XP-per-level formula, pet levels use the official per-rarity XP tables (Golden/Jade/Rose Dragons cap at level 200), and Garden level uses the real Garden XP table (15 levels, capping at 60,120 XP).

Essence upgrade costs (`skyblock_essence_costs`) come from the NotEnoughUpdates `essencecosts.json` constants (bundled in `src/essence-costs.json`). The dataset covers essence-funded stars (1–5 for dungeon gear, up to 10 for crimson/kuudra gear); Master Stars applied with Master Star items are noted but not priced.

For profile reviews, prefer `skyblock_audit` over `skyblock_guide_context` when you want compact gaps and next actions.

The server uses the official Hypixel Public API v2. Keyed endpoints use the `API-Key` header and report rate-limit headers when Hypixel provides them.
