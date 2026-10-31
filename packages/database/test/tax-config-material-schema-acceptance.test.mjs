import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyTaxConfigMaterialSchema } from "../test-support/tax-config-material-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("persists Tax materials, bounded metadata reads and immutable originals without qualification claims", async () => {
  await withIsolatedDatabase({ root, caseId: "tax_materials" }, verifyTaxConfigMaterialSchema);
}, 120_000);
