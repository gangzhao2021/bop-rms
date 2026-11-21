import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/catalog-product-list-acceptance.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
