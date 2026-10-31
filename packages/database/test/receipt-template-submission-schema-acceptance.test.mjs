import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyReceiptTemplateSubmissionSchema } from "../test-support/receipt-template-submission-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Receipt Template Submission immutable schema and current Draft provenance", async () => {
  await withIsolatedDatabase(
    { caseId: "receipt_submission", root },
    verifyReceiptTemplateSubmissionSchema,
  );
}, 120_000);
