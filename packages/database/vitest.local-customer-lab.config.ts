import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/local-customer-lab-acceptance.test.mjs"],
    hookTimeout: 180_000,
    testTimeout: process.env.BOP_LOCAL_CUSTOMER_INTERACTIVE === "1" ? 960_000 : 180_000,
    fileParallelism: false,
    retry: 0,
  },
});
