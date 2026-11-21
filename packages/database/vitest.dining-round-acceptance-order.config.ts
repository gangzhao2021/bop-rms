import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/dining-round-acceptance-order-acceptance.test.mjs"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
