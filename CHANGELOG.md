# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Roadmap (planned for 1.1.0)

- **Net worth: gemstone + reforge valuation** — value socketed gemstones and
  reforge stones (the largest remaining accuracy gap), following the
  SkyHelper-Networth methodology. Gems and reforges are already decoded.
- **Trophy fish** — summarize trophy-fish tiers and catches in the profile.
- **Dungeon + pet-score detail** — deeper dungeon class/run reporting and
  per-pet score / pet-item valuation.
- **Jacob's contests + bingo** — summarize Jacob's farming contest history and
  per-member bingo progress (currently surfaced only as raw data).

## [1.0.2] - 2026-06-28

### Added

- **Automatic retries** for rate-limited (`429`) and transient
  (`502`/`503`/`504` and network) responses, honoring `Retry-After` /
  `RateLimit-Reset` headers and otherwise backing off exponentially with
  jitter. Configurable via `HYPIXEL_MAX_RETRIES` (default `2`). Other `4xx`
  responses and `success: false` envelopes are never retried.
- **Bounded response cache**: the in-memory cache now caps its size
  (`HYPIXEL_CACHE_MAX_ENTRIES`, default `500`), evicting the oldest entry at
  capacity and dropping expired entries on access, so a long-running server no
  longer leaks memory. `cache_clear` now reports how many entries it cleared.

### Fixed

- **Version drift**: the MCP server identity and the outbound `User-Agent` are
  now read from `package.json` at runtime instead of a hardcoded `0.4.0`, so
  they always match the published version.

## [1.0.1] - 2026-06-28

### Changed

- Raised the supported Node.js floor to `>=22` (Node 20 reached end-of-life on
  2026-04-30). CI now tests on Node 22 and 24.
- Updated GitHub Actions to `actions/checkout@v5` and `actions/setup-node@v5`
  and the publish runner to Node 22, clearing the Node 20 deprecation warning.
- Aligned `@types/node` to the supported LTS floor (`^22`).

### Notes

- First release published through the GitHub Actions OIDC trusted-publishing
  pipeline, so it ships with a provenance attestation.

## [1.0.0] - 2026-06-28

### Added

- Initial public release: an AI-facing MCP server for Hypixel SkyBlock profiles,
  inventories/storage, progression (HOTM/HOTF), net worth, essence costs, items,
  Bazaar, auctions, museum, garden, and guide context.
- MIT license, npm package metadata, and a coverage-gated CI workflow.

### Fixed

- Dragon pet leveling: Golden/Jade/Rose Dragon levels 100–200 now follow NEU's
  canonical curve (`[0, 5555, then 1,886,700/level]`) instead of a flat
  1,886,700 per level, which previously under-leveled dragons just past 100.

### Notes

- This version was published manually (to bootstrap the package before an OIDC
  trusted publisher could be configured), so it has no provenance attestation.

[Unreleased]: https://github.com/crithitstudio/hypixel-skyblock-mcp/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/crithitstudio/hypixel-skyblock-mcp/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/crithitstudio/hypixel-skyblock-mcp/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/crithitstudio/hypixel-skyblock-mcp/releases/tag/v1.0.0
