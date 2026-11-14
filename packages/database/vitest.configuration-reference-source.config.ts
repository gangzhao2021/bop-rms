import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    hookTimeout: 180_000,
    testTimeout: 180_000,
    include: ["packages/database/test/configuration-reference-source-acceptance.test.mjs"],
  },
});
