import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/store-phone-before-pickup-acceptance.test.mjs"],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    maxWorkers: 1,
  },
});
