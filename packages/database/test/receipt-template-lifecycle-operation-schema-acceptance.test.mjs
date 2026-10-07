import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyReceiptTemplateLifecycleOperationSchema } from "../test-support/receipt-template-lifecycle-operation-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Receipt Template Approve and Publish originals with independent actors and same-transaction publication", async () => {
  await withIsolatedDatabase(
    { caseId: "receipt_lifecycle", root },
    verifyReceiptTemplateLifecycleOperationSchema,
  );
}, 120_000);
