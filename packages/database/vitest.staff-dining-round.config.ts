import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/staff-dining-round-acceptance.test.mjs"],
    // WP-2423 item 4: the card-machine refund case waits for a business-day change (~1 minute).
    testTimeout: 480_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
