import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: ["packages/database/test/orders-change-mark-acceptance.test.mjs"],
    testTimeout: 600_000,
  },
});
