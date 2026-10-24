import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyTaxRegistrantSource } from "../test-support/tax-registrant-source-acceptance.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("holds actual TaxRegistrant assignment absence and latest profile through PostgreSQL COMMIT", async () => {
  await withIsolatedDatabase({ root, caseId: "tax_registrant" }, verifyTaxRegistrantSource);
}, 120_000);
