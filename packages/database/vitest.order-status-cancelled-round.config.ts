import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/order-status-cancelled-round-acceptance.test.mjs"],
    testTimeout: 480_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
