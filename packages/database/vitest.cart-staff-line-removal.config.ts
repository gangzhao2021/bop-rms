import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/cart-staff-line-removal-acceptance.test.mjs"],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    maxWorkers: 1,
  },
});
