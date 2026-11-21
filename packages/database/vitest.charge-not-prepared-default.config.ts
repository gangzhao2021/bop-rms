import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/charge-not-prepared-default-acceptance.test.mjs"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
