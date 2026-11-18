import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/order-accept-busy-table-acceptance.test.mjs"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
