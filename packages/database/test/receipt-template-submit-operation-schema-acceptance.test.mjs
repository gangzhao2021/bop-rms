import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyReceiptTemplateSubmitOperationSchema } from "../test-support/receipt-template-submit-operation-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Receipt Template Submit original terminals and same-transaction provenance", async () => {
  await withIsolatedDatabase(
    { caseId: "receipt_submit_ops", root },
    verifyReceiptTemplateSubmitOperationSchema,
  );
}, 120_000);
