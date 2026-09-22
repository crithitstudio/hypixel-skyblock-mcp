import { defineConfig } from "vitest/config";

// Gate core data logic and the mocked network/pricing layers. Profile/audit
// orchestration and MCP wiring also have integration tests; the compiled stdio
// entry point is exercised by `npm run smoke` outside Vitest instrumentation.
const COVERAGE_INCLUDE = [
  "src/levels.ts",
  "src/metrics.ts",
  "src/item-modifiers.ts",
  "src/item-lookup.ts",
  "src/essence-costs.ts",
  "src/mayor.ts",
  "src/storage.ts",
  "src/skill-trees.ts",
  "src/progression.ts",
  "src/nbt.ts",
  "src/utils.ts",
  "src/caveats.ts",
  "src/hypixelClient.ts",
  "src/wiki.ts",
  "src/pricing.ts",
  "src/networth.ts",
  "src/upgrade-advisor.ts",
  "src/profile-summaries.ts",
  "src/mcp.ts"
];

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: COVERAGE_INCLUDE,
      reporter: ["text-summary", "text", "lcov"],
      thresholds: {
        statements: 80,
        functions: 80,
        lines: 80,
        branches: 75
      }
    }
  }
});
