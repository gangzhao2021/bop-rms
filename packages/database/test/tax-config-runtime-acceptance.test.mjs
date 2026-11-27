import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { exerciseTaxConfigRuntimeHttp } from "../test-support/tax-config-runtime-http.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("composes ordinary Tax Draft authoring, classifications, mechanical simulation, immutable Candidate preparation and original recovery with actual Session, IAM and FeatureControl", async () => {
  await withIsolatedDatabase({ root, caseId: "tax_runtime_http" }, exerciseTaxConfigRuntimeHttp);
}, 120000);
