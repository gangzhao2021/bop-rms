import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/database/test/category-persistence-acceptance.test.mjs",
      "packages/database/test/category-authority-acceptance.test.mjs",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
