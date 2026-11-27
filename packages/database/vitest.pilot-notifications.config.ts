import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: ["packages/database/test/pilot-notifications-acceptance.test.mjs"],
    testTimeout: 180_000,
  },
});
