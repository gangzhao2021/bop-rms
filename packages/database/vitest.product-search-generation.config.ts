import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/database/test/product-search-generation-acceptance.test.mjs",
      "packages/database/test/product-category-classification-acceptance.test.mjs",
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
