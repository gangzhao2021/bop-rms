import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/pilot-pool-close-acceptance.test.mjs"],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
