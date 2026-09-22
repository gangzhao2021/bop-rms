import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/publishing-mutation-schema-acceptance.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
