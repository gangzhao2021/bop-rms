import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/database/test/metric-definition-acceptance.test.mjs"] },
});
