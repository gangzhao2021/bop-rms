import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exercisePilotStoreTipOff } from "../test-support/pilot-store-tip-off.mjs";

/**
 * v15 2026-11-01 (WP-2423 取舍 11, coordinator): Stores 2 and 3 published Tip Off in Store setup, and
 * guests were still asked and Store 2 took a tip. Published Off now turns tips off, for guests and
 * staff (real session and HTTP, restricted role with the rendered pilot API grants).
 */
it("a Store's published Tip Off means no tip is asked for or taken there", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_tip_off" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: exercisePilotStoreTipOff,
        }),
    }),
  );
});
