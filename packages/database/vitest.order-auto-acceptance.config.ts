import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: [
      "packages/database/test/order-auto-acceptance-acceptance.test.mjs",
      "packages/database/test/order-auto-accepted-pickup-acceptance.test.mjs",
    ],
    testTimeout: 600_000,
  },
});
