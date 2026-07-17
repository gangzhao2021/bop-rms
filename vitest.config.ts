import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["tooling/**/*.{test.ts,test.mjs}", "packages/database/src/**/*.test.ts"],
    passWithNoTests: false,
  },
});
