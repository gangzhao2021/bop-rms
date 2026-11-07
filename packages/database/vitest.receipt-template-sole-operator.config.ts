import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/receipt-template-sole-operator-acceptance.test.mjs"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
