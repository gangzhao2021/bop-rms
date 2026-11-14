import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import { verifyTaxConfigCandidateSchema } from "../test-support/tax-config-candidate-schema-acceptance.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
it("binds immutable Tax candidates and originals to actual Draft/Material sources and reserves publication identities", async () => {
  const result = await withIsolatedDatabase(
    { root, caseId: "tax_candidates" },
    verifyTaxConfigCandidateSchema,
  );
  expect(result).toEqual({
    actualCandidateOwner: true,
    currentAndRoster: true,
    historicalReplay: true,
    durableAbandoned: true,
    parentChildGuards: true,
  });
}, 120_000);
