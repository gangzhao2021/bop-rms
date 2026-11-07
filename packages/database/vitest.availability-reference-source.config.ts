import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/availability-reference-source-acceptance.test.mjs"],
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
