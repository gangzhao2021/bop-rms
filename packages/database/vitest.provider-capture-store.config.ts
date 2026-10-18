import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/provider-capture-store-acceptance.test.mjs"],
    fileParallelism: false,
    hookTimeout: 180000,
    testTimeout: 180000,
  },
});
