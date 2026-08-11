import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/kitchen-work-lifecycle-acceptance.test.mjs"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
