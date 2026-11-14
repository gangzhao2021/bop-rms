import { defineConfig } from "vitest/config";

// WP-2423 M10/M14/M16: refunds and what the order, the kitchen and the guest are told.
export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: ["packages/database/test/refund-lifecycle-acceptance.test.mjs"],
    testTimeout: 600_000,
    maxWorkers: 1,
  },
});
