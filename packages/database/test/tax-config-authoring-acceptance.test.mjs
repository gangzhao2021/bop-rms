import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyTaxConfigAuthoringSchema } from "../test-support/tax-config-authoring-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("executes Tax Draft authoring, immutable originals, native coherence and scope rollback", async () => {
  await withIsolatedDatabase({ root, caseId: "tax_authoring" }, verifyTaxConfigAuthoringSchema);
}, 120_000);
