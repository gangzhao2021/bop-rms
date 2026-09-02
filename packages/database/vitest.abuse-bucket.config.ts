import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 180_000,
    include: ["packages/database/test/abuse-bucket-acceptance.test.mjs"],
    testTimeout: 180_000,
  },
});
