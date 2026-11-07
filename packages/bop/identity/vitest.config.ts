import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // A shared CI runner runs every package at once: give tests room there, keep 5 s locally.
    testTimeout: process.env.CI ? 30_000 : 5_000,
    // turbo runs every package at once on a few CI cores: two workers each keeps the runner usable.
    ...(process.env.CI ? { maxWorkers: 2 } : {}),
    include: ["src/**/*.test.ts"],
  },
});
