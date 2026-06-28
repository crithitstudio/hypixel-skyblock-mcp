import { defineConfig } from "vitest/config";

// The coverage gate is scoped to the deterministic, pure-logic modules. The
// network/orchestration layer (server, hypixelClient, skyblock, audit,
// networth, pricing, gear, accessories) talks to the live Hypixel API and is
// exercised by manual/integration checks rather than unit tests, so it is
// intentionally excluded from the coverage thresholds.
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
  "src/caveats.ts"
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
