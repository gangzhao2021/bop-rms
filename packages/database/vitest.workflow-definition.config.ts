import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/workflow-definition-acceptance.test.mjs"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
