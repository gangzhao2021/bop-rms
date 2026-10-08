import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/order-line-multi-ingredient-acceptance.test.mjs"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
