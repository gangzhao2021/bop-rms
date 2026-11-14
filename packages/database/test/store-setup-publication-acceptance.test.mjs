import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: the Owner saves a complete Store setup through the actual
 * Store setup BFF, then publishes it as the Store's configuration through the pilot composition
 * (restricted role with the rendered pilot API grants): checks in product, two-person approval,
 * append-only versions and audit, the pilot operating reads on the published V2 configuration.
 */
it("publishes a saved Store setup as the Store's configuration through the pilot composition", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_setup_publish" }, (context) =>
    exerciseStoreSetupRuntimeHttp({ ...context, afterSetup: exercisePilotStoreSetupPublication }),
  );
});
