import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    include: ["tooling/**/*.test.ts"],
    passWithNoTests: false,
  },
});
