import { afterEach, expect, it, vi } from "vitest";
import { createInternalPricingPolicy } from "./pilot-pricing-policy.mjs";
const profile = {
  environment: "InternalTest",
  database: "synthetic_pilot",
  createdAt: "2026-07-01T12:00:00.000Z",
  binding: {
    brandReference: "0190fa30-0000-7000-8000-000000000001",
    storeReference: "0190fa30-0000-7000-8000-000000000002",
    validUntil: "2026-10-01T12:00:00.000Z",
  },
};
const menu = {
  environment: "InternalTest",
  database: "synthetic_pilot",
  skuReference: "0190fa30-0000-7000-8000-000000000003",
  taxClassificationReference: "0190fa30-0000-7000-8000-000000000004",
};
const options = () => ({
  loadProfile: async () => profile,
  loadMenu: async () => menu,
  expectedDatabaseName: "synthetic_pilot",
});
afterEach(() => vi.unstubAllEnvs());
it("retains synthetic CAD minor-unit amount, both channels, policy expiry and deterministic digests", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const policy = await createInternalPricingPolicy(options());
  expect(policy.priceBook.entries[0].amount).toEqual({ amountMinor: 1000n, currencyCode: "CAD" });
  expect(
    policy.taxConfiguration.rules.map((v) => ({
      orderType: v.orderType,
      rate: v.rate,
      roundingMode: v.roundingMode,
    })),
  ).toEqual([
    { orderType: "Pickup", rate: "0.13", roundingMode: "HalfUp" },
    { orderType: "DineIn", rate: "0.13", roundingMode: "HalfUp" },
  ]);
  expect(policy.validUntil).toBe(profile.binding.validUntil);
  expect(policy.taxConfiguration.professionalEvidence.snapshotDigest).toBe(
    policy.taxConfiguration.snapshotDigest,
  );
  expect(await createInternalPricingPolicy(options())).toEqual(policy);
});
it("refuses production before reading private configuration", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const loadProfile = vi.fn();
  await expect(createInternalPricingPolicy({ ...options(), loadProfile })).rejects.toThrow(
    "INTERNAL_PRICING_ONLY",
  );
  expect(loadProfile).not.toHaveBeenCalled();
});
it("rejects cross-installation or non-test profile/menu and missing expected database", async () => {
  vi.stubEnv("NODE_ENV", "development");
  for (const change of [
    { expectedDatabaseName: undefined },
    { loadProfile: async () => ({ ...profile, database: "other" }) },
    { loadMenu: async () => ({ ...menu, database: "other" }) },
    { loadMenu: async () => ({ ...menu, environment: "Live" }) },
    { loadProfile: async () => null },
  ])
    await expect(createInternalPricingPolicy({ ...options(), ...change })).rejects.toThrow(
      "INTERNAL_PRICING_ONLY",
    );
});
