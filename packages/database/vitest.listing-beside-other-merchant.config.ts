import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/listing-beside-other-merchant-acceptance.test.mjs"],
    testTimeout: 600_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
