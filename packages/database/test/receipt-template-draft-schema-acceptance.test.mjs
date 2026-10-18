import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyReceiptTemplateDraftSchema } from "../test-support/receipt-template-draft-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Receipt Template Draft immutable schema, publication numbering and original scope", async () => {
  await withIsolatedDatabase({ caseId: "receipt_drafts", root }, verifyReceiptTemplateDraftSchema);
}, 120_000);
