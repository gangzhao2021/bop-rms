import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 300_000,
    include: ["packages/database/test/pilot-resilience-acceptance.test.mjs"],
    testTimeout: 300_000,
  },
});
