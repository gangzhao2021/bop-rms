import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/single-store-dish-batch-save-acceptance.test.mjs"],
    testTimeout: 660_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
