import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/database/test/kds-profile-acceptance.test.mjs"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
