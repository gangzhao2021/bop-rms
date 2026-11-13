import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/merchant-tables-retired-paging-acceptance.test.mjs"],
    fileParallelism: false,
    hookTimeout: 300_000,
    testTimeout: 300_000,
  },
});
