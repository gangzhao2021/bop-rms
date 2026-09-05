import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/cart-item-store-acceptance.test.mjs"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    maxWorkers: 1,
    fileParallelism: false,
    retry: 0,
  },
});
