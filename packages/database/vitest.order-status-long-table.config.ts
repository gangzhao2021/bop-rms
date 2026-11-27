import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/order-status-long-table-acceptance.test.mjs"],
    testTimeout: 480_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
