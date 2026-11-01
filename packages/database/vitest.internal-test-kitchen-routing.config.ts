import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/internal-test-kitchen-routing-acceptance.test.mjs"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
