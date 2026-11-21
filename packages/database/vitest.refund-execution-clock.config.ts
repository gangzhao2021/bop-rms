import { defineConfig } from "vitest/config";

// WP-2423 (guest-waits-and-refund-lock): the refund journeys (request, execution checks, dispatch)
// while this host's clock is half a second ahead of the database's. Docker Desktop's VM drifts from
// the Mac's clock; the test process follows its database's clock, as the pilot's processes do, and
// lands between a statement's start and the database's clock (catalog sources need the one, refunds
// the other).
export default defineConfig({
  test: {
    include: [
      "packages/database/test/additional-submission-writer-acceptance.test.mjs",
      "packages/database/test/public-store-profile-acceptance.test.mjs",
      "packages/database/test/test-process-clock-acceptance.test.mjs",
    ],
    testNamePattern:
      /refund result write fault=false|continues current-clock Dining Entry|test process clock stays between/u,
    setupFiles: ["packages/database/test-support/host-clock-ahead.mjs"],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
