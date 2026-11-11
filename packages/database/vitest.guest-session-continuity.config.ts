import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/guest-session-continuity-acceptance.test.mjs"],
    testTimeout: 600_000,
    hookTimeout: 300_000,
    maxWorkers: 1,
  },
});
