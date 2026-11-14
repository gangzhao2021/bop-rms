import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/price-hold-dish-changes-acceptance.test.mjs"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
