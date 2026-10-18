import { expect, it } from "vitest";
import {
  createBindingAuthorization,
  readStoreOperatingFacts,
  resolveOperatingConfiguration,
} from "./pilot-operating-source.mjs";

const internal = { env: { NODE_ENV: "development" } };
const pilot = { env: { NODE_ENV: "production", BOP_PILOT_ENVIRONMENT: "Pilot" } };

it("WP-2423 StoreOperatingSource: InternalTest keeps its synthetic gate unless the profile names codes", () => {
  expect(resolveOperatingConfiguration({}, internal).liveGateRequirementCodes).toEqual([
    "SYNTHETIC_STORE_READY",
  ]);
  expect(
    resolveOperatingConfiguration(
      {
        operating: {
          liveGateRequirementCodes: ["STORE_INSPECTION_PASSED", "SYNTHETIC_STORE_READY"],
        },
      },
      internal,
    ).liveGateRequirementCodes,
  ).toEqual(["STORE_INSPECTION_PASSED", "SYNTHETIC_STORE_READY"]);
});

it("WP-2423 StoreOperatingSource: a Pilot Store must name real gate codes", () => {
  expect(() => resolveOperatingConfiguration({}, pilot)).toThrow(
    "PILOT_OPERATING_CONFIGURATION_REQUIRED",
  );
  expect(() =>
    resolveOperatingConfiguration(
      { operating: { liveGateRequirementCodes: ["SYNTHETIC_STORE_READY"] } },
      pilot,
    ),
  ).toThrow("PILOT_OPERATING_CONFIGURATION_SYNTHETIC");
  expect(
    resolveOperatingConfiguration(
      { operating: { liveGateRequirementCodes: ["STORE_INSPECTION_PASSED"] } },
      pilot,
    ).liveGateRequirementCodes,
  ).toEqual(["STORE_INSPECTION_PASSED"]);
  for (const operating of [
    { liveGateRequirementCodes: [] },
    { liveGateRequirementCodes: ["lower"] },
    { liveGateRequirementCodes: ["A_CODE", "A_CODE"] },
    { liveGateRequirementCodes: ["A_CODE"], extra: true },
    "A_CODE",
  ])
    expect(() => resolveOperatingConfiguration({ operating }, pilot)).toThrow(
      "PILOT_OPERATING_CONFIGURATION_INVALID",
    );
});

it("WP-2423 StoreOperatingSource: operating authorization is the binding's validity window", async () => {
  const binding = { validFrom: "2026-09-20T00:00:00.000Z", validUntil: "2026-10-20T00:00:00.000Z" };
  const authorize = createBindingAuthorization(binding, () => "2026-10-01T12:00:00.000Z");
  expect(await authorize()).toBe(true);
  expect(await authorize(null, "2026-09-20T00:00:00.000Z")).toBe(true);
  expect(await authorize(null, "2026-10-20T00:00:00.000Z")).toBe(false);
  expect(await authorize(null, "2026-09-19T23:59:59.999Z")).toBe(false);
  expect(await authorize(null, "not-an-instant")).toBe(false);
  expect(() => createBindingAuthorization({ validFrom: "2026-09-20" })).toThrow(
    "PILOT_BINDING_INVALID",
  );
});

it("WP-2423 StoreOperatingSource: the time zone comes from the bound Store record as of now", async () => {
  const scope = {
    brandReference: "019a0000-0000-7000-8000-000000000001",
    storeReference: "019a0000-0000-7000-8000-000000000002",
  };
  const row = {
    store_id: scope.storeReference,
    brand_id: scope.brandReference,
    code: "PILOT-1",
    display_name: "Pilot Store",
    time_zone: "America/Toronto",
    locale: "en-CA",
    currency_code: "CAD",
    lifecycle: "Active",
    version: 3,
    created_at: new Date("2026-09-01T00:00:00.000Z"),
    updated_at: new Date("2026-09-02T00:00:00.000Z"),
  };
  const queries = [];
  const transactions = {
    run: (work) =>
      work({
        async query(sql, values) {
          queries.push([sql, values]);
          return { rows: sql.startsWith("SELECT * FROM bop_tenant.store") ? [row] : [] };
        },
      }),
  };
  const now = () => "2026-10-01T12:00:00.000Z";
  expect(await readStoreOperatingFacts(transactions, scope, now)).toEqual({
    displayName: "Pilot Store",
    timeZone: "America/Toronto",
  });
  expect(queries.at(-1)[1]).toEqual([scope.brandReference, scope.storeReference]);
  await expect(
    readStoreOperatingFacts(transactions, scope, () => "2026-09-01T00:00:00.000Z"),
  ).rejects.toThrow("MERCHANT_ORGANIZATION_UNAVAILABLE");
  await expect(readStoreOperatingFacts(transactions, scope, () => "today")).rejects.toThrow(
    "PILOT_STORE_RECORD_UNAVAILABLE",
  );
});
