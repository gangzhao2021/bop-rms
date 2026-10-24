import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyStoreSetupReferenceSchema } from "../test-support/store-setup-reference-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Store Setup Reference immutable schema, parent history and original scope", async () => {
  await withIsolatedDatabase({ caseId: "store_setup_refs", root }, verifyStoreSetupReferenceSchema);
}, 120_000);
