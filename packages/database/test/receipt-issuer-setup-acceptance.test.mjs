import { it, vi } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseStoreSetupRuntimeHttp } from "../test-support/store-setup-runtime-http.mjs";
import { exercisePilotStoreSetupPublication } from "../test-support/pilot-store-setup-publication.mjs";
import { exercisePilotReceiptIssuerSetup } from "../test-support/pilot-receipt-issuer-setup.mjs";

/**
 * v15 2026-11-01: a Store whose Owner saves "Receipts and privacy" (numbers empty) has a receipt
 * issuer, so its paid orders get receipts naming the business; another Store is untouched
 * (restricted role with the rendered pilot API grants).
 */
it("a Store's receipts name the business its Owner saved in Receipts and privacy", async () => {
  vi.stubEnv("NODE_ENV", "development");
  await withIsolatedDatabase({ caseId: "wp2423_rcpt_issuer" }, (context) =>
    exerciseStoreSetupRuntimeHttp({
      ...context,
      afterSetup: (input) =>
        exercisePilotStoreSetupPublication({
          ...input,
          afterPublication: exercisePilotReceiptIssuerSetup,
        }),
    }),
  );
});
