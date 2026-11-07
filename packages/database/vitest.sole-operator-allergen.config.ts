import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/sole-operator-allergen-acceptance.test.mjs"],
    testTimeout: 240_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
