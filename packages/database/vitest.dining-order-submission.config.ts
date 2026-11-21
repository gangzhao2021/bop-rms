import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/dining-order-submission-composition-acceptance.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
