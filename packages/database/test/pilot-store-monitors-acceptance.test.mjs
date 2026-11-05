import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exercisePilotStoreMonitors } from "../test-support/pilot-store-monitors.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";

/**
 * DEC-PILOT-ALERTS-BACKUP correction 2 (item 15): Home at a new merchant said "Store system problems
 * are not being checked" because the monitor wrote one board, for the first Store, and read money
 * signals for that Store only. Now each served Store gets a board from its own facts, as the
 * restricted role with the rendered pilot API grants.
 */
it("each served Store's board comes from its own facts, read as the restricted role", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_monitors" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: exercisePilotStoreMonitors,
        }),
    }),
  );
});
