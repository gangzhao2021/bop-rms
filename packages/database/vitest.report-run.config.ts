import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/database/test/report-run-acceptance.test.mjs"] },
});
