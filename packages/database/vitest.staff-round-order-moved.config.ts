import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/staff-round-order-moved-acceptance.test.mjs"],
    testTimeout: 480_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
