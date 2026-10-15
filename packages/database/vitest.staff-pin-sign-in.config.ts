import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: ["packages/database/test/staff-pin-sign-in-acceptance.test.mjs"],
    testTimeout: 300_000,
  },
});
