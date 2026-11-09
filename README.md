# Hypixel SkyBlock MCP — Retired

**Project status: Retired (November 9, 2026). Do not use this MCP server to connect AI tools to Hypixel's API.**

Hypixel Support informed the maintainer in ticket **#1214029** (October 2026) that AI tools accessing the Hypixel API are not permitted under their current interpretation of the rules, that asking users to supply their own API keys does not make this distributed integration acceptable, and that this project's proposed API use would not receive approval. See [Hypixel's current API policy](https://developer.hypixel.net/policies/).

The public source code is retained **solely as a historical reference**. The 23-tool, API-connected MCP integration has **not** been approved by Hypixel and is no longer maintained or offered as a recommended integration. Do not follow historical setup instructions to run it against Hypixel's API. This project is not affiliated with, endorsed by, or supported by Hypixel.

## Existing users

- **Stop using the API-connected MCP server.** Remove `hypixel-skyblock-mcp` from your MCP client configuration.
- The previously published npm package may still be downloadable, and installed versions are **not automatically disabled** by a GitHub notice. A separate npm deprecation is necessary.
- Do not put Hypixel API keys in third-party tools or services. If a key was exposed or shared, revoke/rotate it in the Hypixel Developer Dashboard as appropriate.
- This repository no longer automatically publishes to npm on GitHub Releases.

## Historical reference

The [original technical documentation](docs/HISTORICAL_README.md), implementation, release tags, and Git history are preserved for reference **only**; they are not instructions to deploy a permitted integration. See [retirement checklist](docs/RETIREMENT.md) for remaining package-owner and repository-owner actions.

A future standalone, offline SkyBlock analysis tool would require an independently reviewed design that does not access the Hypixel API through an AI tool. No such successor is announced or authorized by this repository.

## License

The preserved source is distributed under the [MIT License](LICENSE). The license is not permission to use Hypixel's API contrary to its rules.
