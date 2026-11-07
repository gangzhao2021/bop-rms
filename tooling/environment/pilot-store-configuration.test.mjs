import { describe, expect, it } from "vitest";
import { storeHoursChangeAllowed, storeHoursReview } from "./pilot-store-configuration.mjs";

const id = (n) => `018f9f40-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const publishedAt = "2026-10-01T12:00:00.000Z";
const now = "2026-10-10T15:00:00.000Z";
const interval = (start, end) => ({
  startLocalTime: start,
  endLocalTime: end,
  endsNextDay: false,
  serviceModes: ["Pickup"],
  orderCutoffSeconds: 900,
  leadTimeSeconds: 600,
});
const baseline = Object.freeze({
  configurationReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 1,
  lifecycle: "Published",
  source: "StoreOverride",
  brandBaseVersionReference: id(4),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(5),
  contactReference: id(6),
  receiptReference: id(7),
  taxConfigurationReference: id(8),
  paymentConfigurationReference: id(9),
  capacityConfigurationReference: null,
  enabledServiceModes: ["Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, index) => ({
    isoWeekday: index + 1,
    intervals: [interval("11:00:00", "21:00:00")],
  })),
  exceptions: [],
  effectiveFrom: publishedAt,
  effectiveUntil: null,
  supersedesConfigurationReference: null,
  reasonCode: "PILOT_CONFIGURATION",
  authoredByReference: id(10),
  approvedByReference: id(11),
  approvalEvidenceReference: id(12),
  publicationReference: id(13),
  liveGateEvidenceReference: id(14),
  createdAt: publishedAt,
  updatedAt: publishedAt,
  dataClassification: "ConfigurationMetadata",
});
// A manager's draft: new hours, a holiday closure and a reason, effective from when it was saved.
const draft = Object.freeze({
  ...baseline,
  configurationReference: id(20),
  configurationVersion: 2,
  lifecycle: "Draft",
  supersedesConfigurationReference: id(1),
  weeklySchedule: baseline.weeklySchedule.map((day) =>
    day.isoWeekday === 7 ? { ...day, intervals: [] } : day,
  ),
  exceptions: [{ localDate: "2026-12-25", kind: "Holiday", intervals: [] }],
  reasonCode: "STORE_HOURS_UPDATE",
  effectiveFrom: "2026-10-10T14:00:00.000Z",
  authoredByReference: id(21),
  approvedByReference: null,
  approvalEvidenceReference: null,
  publicationReference: null,
  liveGateEvidenceReference: null,
  createdAt: "2026-10-10T14:00:00.000Z",
  updatedAt: "2026-10-10T14:00:00.000Z",
});

describe("WP-2423 Q4 store hours reference guard", () => {
  it("accepts weekly hours, dated closures and the change reason", () => {
    expect(storeHoursChangeAllowed(baseline, draft, now)).toBe(true);
    expect(storeHoursChangeAllowed(baseline, { ...draft, effectiveFrom: now }, now)).toBe(true);
  });
  it.each([
    ["tax configuration", { taxConfigurationReference: id(30) }],
    ["payment configuration", { paymentConfigurationReference: id(31) }],
    ["receipt", { receiptReference: id(32) }],
    ["address", { addressReference: id(33) }],
    ["contact", { contactReference: id(34) }],
    ["capacity", { capacityConfigurationReference: id(35) }],
    ["brand base", { brandBaseVersionReference: id(36) }],
    ["service modes", { enabledServiceModes: ["Pickup", "DineIn"] }],
    ["business-day start", { businessDayStartLocalTime: "05:00:00" }],
    ["time zone", { timeZone: "America/Vancouver" }],
    ["locale", { defaultLocale: "fr-CA" }],
    ["source", { source: "BrandInherited" }],
    ["Store", { storeReference: id(37) }],
  ])("rejects a change to the %s", (_name, change) => {
    expect(storeHoursChangeAllowed(baseline, { ...draft, ...change }, now)).toBe(false);
  });
  it("rejects a window the operating reader would not select as the successor", () => {
    expect(
      storeHoursChangeAllowed(
        baseline,
        { ...draft, effectiveFrom: "2026-10-11T00:00:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      storeHoursChangeAllowed(
        baseline,
        { ...draft, effectiveFrom: "2026-09-30T00:00:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      storeHoursChangeAllowed(
        baseline,
        { ...draft, effectiveUntil: "2026-12-31T00:00:00.000Z" },
        now,
      ),
    ).toBe(false);
  });
  it("keeps an installed configuration and one from Store setup apart, and needs a baseline", () => {
    const setupBasis = basis(1);
    expect(storeHoursChangeAllowed(baseline, { ...draft, setupBasis }, now)).toBe(false);
    expect(storeHoursChangeAllowed({ ...baseline, setupBasis }, draft, now)).toBe(false);
    expect(storeHoursChangeAllowed(null, draft, now)).toBe(false);
  });
});

const fees = (state) =>
  ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({ chargeType, state }));
const basis = (revision, overrides = {}) => ({
  profile: "StoreSetupConfigurationBasisV2",
  tenantReference: id(40),
  setupDraftReference: id(41),
  sourceRevision: revision,
  sourceSnapshotDigest: "sha256:" + String(revision).repeat(64).slice(0, 64),
  feeContexts: fees("Disabled"),
  ...overrides,
});
describe("WP-2423 Q4 hours change on a configuration from Store setup", () => {
  const published = { ...baseline, setupBasis: basis(1) };
  // The hours-only Store setup revision 2 and the draft configuration made from it.
  const candidate = { ...draft, setupBasis: basis(2) };
  it("accepts hours and closures from a newer hours-only Store setup revision", () => {
    expect(storeHoursChangeAllowed(published, candidate, now)).toBe(true);
  });
  it.each([
    ["fee settings", { setupBasis: basis(2, { feeContexts: fees("Unconfigured") }) }],
    ["tenant", { setupBasis: basis(2, { tenantReference: id(99) }) }],
    ["tax configuration", { taxConfigurationReference: id(30) }],
    ["time zone", { timeZone: "America/Vancouver" }],
    ["service modes", { enabledServiceModes: ["Pickup", "DineIn"] }],
    ["effective window", { effectiveUntil: "2026-12-31T00:00:00.000Z" }],
  ])("rejects a change to the %s", (_name, change) => {
    expect(storeHoursChangeAllowed(published, { ...candidate, ...change }, now)).toBe(false);
  });
});

describe("WP-2423 Q4 store hours review", () => {
  it("records the unchanged-references check for seven days with the published live gate", () => {
    expect(storeHoursReview(baseline, now)).toEqual({
      validUntil: "2026-10-17T15:00:00.000Z",
      checkCodes: ["STORE_HOURS_REFERENCES_UNCHANGED"],
      liveGateEvidenceReference: id(14),
    });
  });
  it("fails closed without a published live gate", () => {
    expect(() => storeHoursReview(null, now)).toThrow("PILOT_STORE_CONFIGURATION_UNAVAILABLE");
    expect(() => storeHoursReview({ ...baseline, liveGateEvidenceReference: null }, now)).toThrow(
      "PILOT_STORE_CONFIGURATION_UNAVAILABLE",
    );
  });
});
