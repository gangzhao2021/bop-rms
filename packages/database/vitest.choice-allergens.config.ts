import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/choice-allergens-acceptance.test.mjs"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
