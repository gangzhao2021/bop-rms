import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/database/test/data-quality-reconciliation-acceptance.test.mjs"] },
});
