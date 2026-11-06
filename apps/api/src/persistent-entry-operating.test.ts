import { expect, it, vi } from "vitest";
import { CustomerEntryServiceUnavailableError } from "./customer-entry-composition.js";
import { customerFailureCode } from "./customer-failure-diagnostic.js";
import { createPersistentEntryOperatingReader } from "./persistent-entry-operating.js";

const id = (n: number) => "01909981-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-01-15T12:00:00.000Z";
const binding = {
  tenantReference: id(1),
  publicStoreReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  lookupEvidenceReference: id(5),
  validFrom: "2026-01-01T00:00:00.000Z",
  validUntil: "2026-02-01T00:00:00.000Z",
};

/** The binding is no longer authorized: what the facts say, read in a transaction. */
function reader(query: (sql: string, values: readonly unknown[]) => Promise<unknown>) {
  const transaction = { query: vi.fn(query) };
  return {
    transaction,
    reader: createPersistentEntryOperatingReader({
      transaction: transaction as never,
      publicStore: { binding, authorize: async () => false },
      operating: {
        tenantReference: binding.tenantReference,
        brandReference: binding.brandReference,
        storeReference: binding.storeReference,
      } as never,
    }),
  };
}
const input = {
  brandReference: binding.brandReference,
  storeReference: binding.storeReference,
  publicStoreReference: binding.publicStoreReference,
  evaluatedAt: at,
};

it("WP-2423: a Store the facts don't offer is unusable while the database answers", async () => {
  const { reader: current, transaction } = reader(async () => ({ rows: [{ "?column?": 1 }] }));
  expect(await current.readCurrent(input)).toBeNull();
  expect(transaction.query).toHaveBeenCalledWith("SELECT 1", []);
});

it("WP-2423: a database that can't answer Entry's read is an outage (503), not an unusable code", async () => {
  const lost = Object.assign(new Error("TENANT_DATABASE_TRANSACTION_FAILED"), {
    code: "TENANT_DATABASE_TRANSACTION_FAILED",
    diagnostic: { sqlState: "42501" },
  });
  const { reader: current } = reader(async () => {
    throw lost;
  });
  const failure = await current.readCurrent(input).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(CustomerEntryServiceUnavailableError);
  // The request log is told the class of failure only.
  expect(customerFailureCode(failure)).toBe("TENANT_DATABASE_TRANSACTION_FAILED_SQL_42501");
});

it("WP-2423: a scan for another Store is unusable without asking the database", async () => {
  const { reader: current, transaction } = reader(async () => {
    throw new Error("not reached");
  });
  expect(await current.readCurrent({ ...input, storeReference: id(9) })).toBeNull();
  expect(transaction.query).not.toHaveBeenCalled();
});
