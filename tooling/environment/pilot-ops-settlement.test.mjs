import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readPilotHasClosedBusinessDay } from "./pilot-ops-settlement.mjs";

/**
 * DEC-PILOT-ALERTS-BACKUP correction 2: "has this Store a closed business day" decides whether BOP
 * is told a Store's payments are not compared with the Provider. Only the read's own answer may
 * say no; the database reads themselves are covered by the restricted-role acceptance
 * (pilot-store-monitors). Here the transaction answers as the runner would.
 */
const scope = {
  brandReference: "018f5000-0000-7000-8000-000000000002",
  storeReference: "018f5000-0000-7000-8000-000000000003",
};
const installation = {
  database: "isolated",
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

it("a closed day it can bound is a closed day", async () => {
  expect(
    await readPilotHasClosedBusinessDay({ resources: resources(async () => ({})), installation }),
  ).toBe(true);
});

it("says no only for the read's own 'no published hours before today'", async () => {
  for (const code of [
    "STORE_BUSINESS_DATE_UNAVAILABLE",
    "SIMULATION_SETTLEMENT_WINDOW_UNAVAILABLE",
  ])
    expect(
      await readPilotHasClosedBusinessDay({ resources: failing(new Error(code)), installation }),
    ).toBe(false);
});

it("a refused or failed read is no answer: it fails, so the check reads as not run", async () => {
  const refused = afterFailedQuery(new Error("STORE_BUSINESS_DATE_UNAVAILABLE"), "42501");
  await expect(
    readPilotHasClosedBusinessDay({ resources: failing(refused), installation }),
  ).rejects.toBe(refused);
  const conflict = Object.assign(new Error("TENANT_DATABASE_TRANSACTION_CONFLICT"), {
    code: "TENANT_DATABASE_TRANSACTION_CONFLICT",
  });
  await expect(
    readPilotHasClosedBusinessDay({ resources: failing(conflict), installation }),
  ).rejects.toBe(conflict);
  const unreadable = new Error("PILOT_INSTALLATION_UNAVAILABLE");
  await expect(
    readPilotHasClosedBusinessDay({
      resources: resources(async () => ({})),
      installation: {
        ...installation,
        loadProfile: async () => {
          throw unreadable;
        },
      },
    }),
  ).rejects.toBe(unreadable);
});
