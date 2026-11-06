import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/database/test/sole-operator-staff-role-acceptance.test.mjs"],
    fileParallelism: false,
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
