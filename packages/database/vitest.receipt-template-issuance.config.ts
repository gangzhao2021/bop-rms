import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/receipt-template-issuance-acceptance.test.mjs"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
