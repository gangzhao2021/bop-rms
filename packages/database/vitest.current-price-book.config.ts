import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/database/test/current-price-book-acceptance.test.mjs",
      "packages/database/test/merchant-price-book-commands-acceptance.test.mjs",
      "packages/database/test/current-option-price-acceptance.test.mjs",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
