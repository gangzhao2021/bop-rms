import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyStorePublicationSetupBasis } from "../test-support/store-publication-setup-basis-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Store publication Setup basis immutable-source coherence and legacy compatibility", async () => {
  await withIsolatedDatabase({ caseId: "store_pub_basis", root }, verifyStorePublicationSetupBasis);
}, 120_000);
