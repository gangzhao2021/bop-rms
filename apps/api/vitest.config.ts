import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    // A shared CI runner runs every package at once: give tests room there, keep 5 s locally.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    clearMocks: true,
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    passWithNoTests: false,
  },
});
