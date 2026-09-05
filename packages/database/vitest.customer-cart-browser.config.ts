import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    hookTimeout: 180_000,
    testTimeout: 180_000,
    include: ["packages/database/test/customer-cart-browser-acceptance.test.mjs"],
  },
});
