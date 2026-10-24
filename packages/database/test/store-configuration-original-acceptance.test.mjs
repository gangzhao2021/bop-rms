import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyStoreConfigurationOriginal } from "../test-support/store-configuration-original-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Store configuration durable originals, same-transaction commits and abandonment fences", async () => {
  await withIsolatedDatabase({ caseId: "store_originals", root }, verifyStoreConfigurationOriginal);
}, 120_000);
