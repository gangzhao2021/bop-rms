import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exercisePilotReceiptTemplateIssuance } from "../test-support/pilot-receipt-template-issuance.mjs";

/**
 * WP-2423 DEC-STORE-SETUP-PUBLICATION: receipts are issued with the template the Store's published
 * configuration names — a template the Owner wrote and approved alone, then the installed one
 * again — and refused with a plain reason and an alert when that template cannot be proven
 * (restricted role with the rendered pilot API grants).
 */
it("issues receipts with the template the published Store configuration names", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_receipt_issue" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: exercisePilotReceiptTemplateIssuance,
        }),
    }),
  );
});
