import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: [
      "packages/database/test/identity-session-store-acceptance.test.mjs",
      "packages/database/test/customer-entry-persistence-acceptance.test.mjs",
    ],
    testTimeout: 180_000,
  },
});
