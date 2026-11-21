import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url));
export default defineConfig({
  resolve: {
    // The pilot tooling compositions import the built API/worker; the journey runs them over the
    // current sources instead, so it never depends on a stale build.
    alias: [
      {
        find: /^(?:\.\.\/)+apps\/(api|worker)\/dist\/(.+)\.js$/u,
        replacement: root + "apps/$1/src/$2.ts",
      },
    ],
  },
  test: {
    include: ["packages/database/test/dine-in-journey-acceptance.test.mjs"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
