import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["packages/database/test/pipeline-run-acceptance.test.mjs"] },
});
