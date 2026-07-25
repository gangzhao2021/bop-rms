import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["events/**/*.test.ts"],
  },
});
