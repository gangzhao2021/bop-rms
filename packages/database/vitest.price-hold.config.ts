import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/price-hold-acceptance.test.mjs"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
