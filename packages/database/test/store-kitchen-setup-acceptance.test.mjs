import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exercisePilotStoreKitchenSetup } from "../test-support/pilot-store-kitchen-setup.mjs";

/**
 * WP-2423 item 11 (Owner 2026-11-01): a Store opened in the product gets its kitchen routing in the
 * product (real session, HTTP route, restricted role with the rendered pilot API grants). Until
 * then its menus can't be listed and it takes no order; another Store is untouched.
 */
it("a Store's Owner sets up its kitchen in Store setup, and until then it takes no order", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_kitchen_setup" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: exercisePilotStoreKitchenSetup,
        }),
    }),
  );
});
