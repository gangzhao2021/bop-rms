import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/feature-control-administration-acceptance.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
