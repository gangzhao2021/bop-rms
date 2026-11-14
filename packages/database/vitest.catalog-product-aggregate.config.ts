import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/database/test/catalog-product-aggregate-acceptance.test.mjs",
      "packages/database/test/product-lifecycle-persistence-acceptance.test.mjs",
      "packages/database/test/product-creation-persistence-acceptance.test.mjs",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
