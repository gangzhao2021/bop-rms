import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("../..", import.meta.url));
export default defineConfig({
  resolve: {
    // The real-path case composes the pilot tooling, which imports the built API; run it over the
    // current sources instead so it never depends on a stale build.
    alias: [
      {
        find: /^(?:\.\.\/)+apps\/(api|worker)\/dist\/(.+)\.js$/u,
        replacement: root + "apps/$1/src/$2.ts",
      },
    ],
  },
  test: {
    include: [
      "packages/database/test/dining-guest-invitation-acceptance.test.mjs",
      "packages/database/test/dining-guest-invitation-http-acceptance.test.mjs",
    ],
    testTimeout: 180_000,
    hookTimeout: 120_000,
    maxWorkers: 1,
  },
});
