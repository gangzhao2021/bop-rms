import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/brand-admin-acceptance.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
