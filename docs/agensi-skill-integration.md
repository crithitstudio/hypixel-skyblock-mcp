# Companion agent-skill integration (draft)

This repository provides the **open-source MCP server** for Hypixel SkyBlock. A separate, optional agent skill may guide an MCP-capable assistant on when to invoke its tools and how to interpret returned data. The skill is **not bundled with this repository**.

## Public integration contract

- Server package: `hypixel-skyblock-mcp` (Node.js 22+).
- Installation and environment: follow the [server README](../README.md); each local installation is separately configured. Never commit an API key or ask an AI agent to print one.
- Local MCP setup: register the `hypixel-skyblock` stdio server with an MCP-capable client; verify `server_status` and tool discovery before use.
- Common read-only workflows: `skyblock_profiles` → `skyblock_audit` for progression; `skyblock_upgrade_advisor` for cost-ranked upgrades; `skyblock_networth` for valuation with coverage; `skyblock_storage` for cross-container searches; `skyblock_bazaar` for market signals.
- These tools return incomplete or time-sensitive information under some circumstances. Companion instructions must never invent missing prices, infer unavailable inventories, promise profits, or call cost-based rankings mathematical optima.
- `cache_clear` changes local cache state; do not present it as a read-only operation.
- Official Hypixel wiki access was retired in July 2026; any configured replacement MediaWiki provider must be described as unofficial.

## Third-party commercial listing boundary

The commercial skill is a **separate instructional product**, not the MCP server. The server remains independently distributed under its existing MIT license. No third-party skill should claim to include the server, supply API keys, or suggest endorsement by Hypixel, Mojang, or Microsoft.

**Do not publish or market an API-dependent commercial skill without confirming compliance with [Hypixel's current API policies](https://developer.hypixel.net/policies/)**, including registration/Production requirements, restrictions on API proxying and key sharing, free-tier requirements, and rules for transformative paid content. A local user-supplied key is not by itself proof that an architecture is approved. Consult Hypixel support for the specific model before releasing.

This public document does not include paid `SKILL.md` instructions or a release-ready marketplace ZIP. Keep any commercial package in a private workspace until approved and tested.

## Verification checklist

- [ ] Review current Hypixel policy and document a compliant launch architecture.
- [ ] Confirm local MCP initialization, expected tool schemas, and successful read-only examples.
- [ ] Test agent skill activation in real supported clients before claiming compatibility.
- [ ] Review pricing, attribution, marketplace terms, and buyer disclosures.
- [ ] Publish the separate commercial skill only after explicit release approval.
