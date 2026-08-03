import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/order-number-allocation-acceptance.test.mjs"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    sequence: { concurrent: false },
  },
});
