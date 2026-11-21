import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: ["packages/database/test/cognito-store-staff-acceptance.test.mjs"],
    testTimeout: 300_000,
  },
});
