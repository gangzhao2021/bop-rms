import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/database/test/cart-aggregate-acceptance.test.mjs",
      "packages/database/test/cart-query-store-acceptance.test.mjs",
      "packages/database/test/cart-item-command-store-acceptance.test.mjs",
      "packages/database/test/cart-binding-store-acceptance.test.mjs",
      "packages/database/test/cart-lifecycle-store-acceptance.test.mjs",
      "packages/database/test/cart-quote-store-acceptance.test.mjs",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
