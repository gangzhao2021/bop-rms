import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/public-store-profile-acceptance.test.mjs"],
    fileParallelism: false,
    hookTimeout: 180000,
    testTimeout: 180000,
  },
});
