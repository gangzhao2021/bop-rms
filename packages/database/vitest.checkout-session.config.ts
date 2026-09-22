import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "packages/database/test/checkout-session-store-acceptance.test.mjs",
      "packages/database/test/checkout-session-adapter-acceptance.test.mjs",
    ],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
