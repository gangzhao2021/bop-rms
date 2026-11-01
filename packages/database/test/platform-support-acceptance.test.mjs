import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exercisePilotPlatformSupport } from "../test-support/pilot-platform-support.mjs";

/**
 * WP-2423 取舍 15 (Owner 2026-10-28): platform support staff, on a published Store, through the real
 * session and merchant routes, as the restricted role holding the rendered pilot API grants.
 */
it("support views and is recorded, changes only while the Owner allows, never touches money", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_support" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: exercisePilotPlatformSupport,
        }),
    }),
  );
});
