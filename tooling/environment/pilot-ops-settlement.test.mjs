import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readPilotSettlementProblems } from "./pilot-ops-settlement.mjs";

/**
 * WP-2423 (settlement-coverage): the monitor's settlement read starts from the Store's own first
 * business day; "no closed day yet" is only the read's own answer (no configuration governs). A
 * refused or failed read throws, so the check reads as not run. The database reads themselves are
 * covered by the restricted-role acceptance (store-settlement-coverage). Here the transaction
 * answers as the runner would.
 */
const scope = {
  brandReference: "018f5000-0000-7000-8000-000000000002",
  storeReference: "018f5000-0000-7000-8000-000000000003",
};
const installation = {
  database: "isolated",
  loadRecordedDailySettlementCoverage: async () => null,
  loadProfile: async () => ({
    environment: "InternalTest",
    database: "isolated",
    binding: { ...scope, validUntil: "2099-01-01T00:00:00.000Z" },
  }),
};
const resources = (run) => ({
  scope,
  operating: { timeZone: "America/Toronto", authorize: async () => true },
  now: () => "2026-11-05T12:00:00.000Z",
  transactions: { run },
});
const failing = (error) =>
  resources(async () => {
    throw error;
  });
/** What the transaction runner adds when one of the transaction's queries failed. */
const afterFailedQuery = (error, sqlState) =>
  Object.defineProperty(error, Symbol.for("bop.database.failure"), {
    value: { sqlState },
    enumerable: false,
  });

beforeEach(() => vi.stubEnv("NODE_ENV", "development"));
afterEach(() => vi.unstubAllEnvs());

/** A transaction whose first-configuration read answers `first` (null: nothing governs yet). */
const governing = (first) =>
  resources(async (work) => work({ query: async () => ({ rows: [{ first }] }) }));

it("a Store whose configuration does not govern yet has no closed day to list", async () => {
  expect(await readPilotSettlementProblems({ resources: governing(null), installation })).toEqual({
    days: [],
  });
});

it("a refused or failed read is no answer: it fails, so the check reads as not run", async () => {
  const refused = afterFailedQuery(new Error("STORE_BUSINESS_DATE_UNAVAILABLE"), "42501");
  await expect(
    readPilotSettlementProblems({ resources: failing(refused), installation }),
  ).rejects.toBe(refused);
  const conflict = Object.assign(new Error("TENANT_DATABASE_TRANSACTION_CONFLICT"), {
    code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
  });
  await expect(
    readPilotSettlementProblems({ resources: failing(conflict), installation }),
  ).rejects.toBe(conflict);
  const unreadable = new Error("PILOT_INSTALLATION_UNAVAILABLE");
  await expect(
    readPilotSettlementProblems({
      resources: governing(null),
      installation: {
        ...installation,
        loadProfile: async () => {
          throw unreadable;
        },
      },
    }),
  ).rejects.toBe(unreadable);
  await expect(
    readPilotSettlementProblems({
      resources: governing(null),
      installation: {
        ...installation,
        loadRecordedDailySettlementCoverage: async () => {
          throw unreadable;
        },
      },
    }),
  ).rejects.toBe(unreadable);
});
