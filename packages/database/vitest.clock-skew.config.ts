import { defineConfig } from "vitest/config";

// WP-2423: the real staff round, with payment and refund, on an application host whose clock is
// ahead of the database's; the served pilot's database clock keeps every comparison true.
export default defineConfig({
  test: {
    include: [
      "packages/database/test/staff-dining-round-acceptance.test.mjs",
      "packages/database/test/dining-pay-later-round-acceptance.test.mjs",
    ],
    // The first staff test composes its own connections, so it has no pilot database clock.
    testNamePattern: /^(?!enters a dine-in round by staff)/u,
    setupFiles: ["packages/database/test-support/application-clock-ahead.mjs"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
