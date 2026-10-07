import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyStorePaymentConfigurationSchema } from "../test-support/store-payment-configuration-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("enforces Store Payment Configuration immutable schema, disabled rules and original scope", async () => {
  await withIsolatedDatabase(
    { caseId: "store_payment_cfg", root },
    verifyStorePaymentConfigurationSchema,
  );
}, 120_000);
