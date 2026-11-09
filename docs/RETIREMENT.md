# Retirement checklist

Updated: November 9, 2026.

## Context

Hypixel Support's response to ticket #1214029 states that AI tools directly accessing the Hypixel API are not currently permitted, including this distributed MCP design with user-provided keys. The repository has therefore stopped recommending or maintaining the API-connected integration.

## Completed in the source repository

- [x] Prominent retirement notice replaces the installation guide.
- [x] Earlier technical README preserved as `docs/HISTORICAL_README.md`, labeled historical.
- [x] GitHub Release-triggered npm publishing workflow removed.
- [x] Implementation and Git history preserved; no user data or credentials deleted.

## Actions requiring the service owner

- [ ] **Deprecate every published npm version** (requires the npm package owner's login and possible 2FA):
  ```sh
  npm deprecate 'hypixel-skyblock-mcp@*' 'Retired: this API-connected AI/MCP integration is not approved by Hypixel. Do not use it.'
  npm view 'hypixel-skyblock-mcp@1.1.0' deprecated
  ```
  The second command checks the latest known published version; confirm all other published versions are also deprecated. Deprecation warns installers; it does not uninstall existing copies or revoke credentials.
- [ ] Stop any running/hosted instances; remove this server from any AI/MCP client configurations under your control.
- [ ] Review exposed or shared API keys, if any, and revoke/rotate as appropriate. Do not publish key values.
- [ ] After the retirement PR is merged, **archive** the GitHub repository via `Settings → General → Danger Zone → Archive this repository`. Archiving makes it read-only; it does not remove the npm package.
- [ ] Confirm the npm page shows the deprecation warning, the GitHub default branch prominently shows retirement, and no release-triggered publishing workflow remains.

Do not publish another API-connected MCP build or revive the integration unless Hypixel expressly authorizes the **specific** design in writing. Do not assume an offline tool, separate paid AI skill, or manually supplied player dataset is automatically approved for every possible distribution or monetization model; evaluate its actual sources, behavior, and rights first.
