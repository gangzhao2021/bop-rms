import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/staff-round-same-table-race-acceptance.test.mjs"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
