import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/payment-compensation-operations-acceptance.test.mjs"],
    testTimeout: 120000,
    hookTimeout: 120000,
    maxWorkers: 1,
  },
});
