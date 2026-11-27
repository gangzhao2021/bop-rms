import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/dining-join-code-unique-acceptance.test.mjs"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    maxWorkers: 1,
  },
});
