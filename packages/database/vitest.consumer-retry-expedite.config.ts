import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/consumer-retry-expedite-acceptance.test.mjs"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 300_000,
  },
});
