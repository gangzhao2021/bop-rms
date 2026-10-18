import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyReceiptTemplateArtifactSchema } from "../test-support/receipt-template-artifact-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Receipt Template Artifact immutable schema, parent history and original scope", async () => {
  await withIsolatedDatabase(
    { caseId: "receipt_artifacts", root },
    verifyReceiptTemplateArtifactSchema,
  );
}, 120_000);
