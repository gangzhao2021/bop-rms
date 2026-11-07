import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/payment-compensation-refund-acceptance.test.mjs"],
    testTimeout: 120000,
    hookTimeout: 120000,
    maxWorkers: 1,
  },
});
