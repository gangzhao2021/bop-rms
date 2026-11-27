import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotReceiptTemplateSoleOperator } from "../test-support/pilot-receipt-template-sole-operator.mjs";

/**
 * WP-2423 (Owner decision 2026-10-16): after the actual Store setup BFF has made, sent, approved
 * (two people) and published a receipt template, the pilot composition (restricted role with the
 * rendered pilot API grants) reads the installer-published template the Store uses today, and an
 * Owner approves their own receipt template alone as sole operator (marked, audited, guarded).
 */
it("reuses the installed receipt template and approves an Owner's own template as sole operator", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_receipt_sole" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: exercisePilotReceiptTemplateSoleOperator,
    }),
  );
});
