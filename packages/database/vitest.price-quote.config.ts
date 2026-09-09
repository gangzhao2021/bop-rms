import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/database/test/price-quote-acceptance.test.mjs",
      "packages/database/test/price-quote-store-acceptance.test.mjs",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
