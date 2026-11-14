import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { createStoreConfigurationVersion } from "@rms/store";
import {
  evaluateStoreConfigurationPublication,
  parseStoreConfigurationPublicationChecks,
  storeConfigurationPublicationCheckCodes,
  storeConfigurationPublicationReady,
  type StoreConfigurationPublicationFacts,
} from "./merchant-store-configuration-publication-checks.js";
import { parseMerchantStoreConfigurationOrdinaryWorkspace } from "./merchant-store-configuration-ordinary-values.js";

const id = (n: number) => `01902421-1013-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-15T14:00:00.000Z";
const interval = (modes: string[]) => ({
  startLocalTime: "08:00:00",
  endLocalTime: "20:00:00",
  endsNextDay: false,
  serviceModes: modes,
  orderCutoffSeconds: 0,
  leadTimeSeconds: 0,
});
const base = {
  configurationReference: id(10),
  brandReference: id(2),
  storeReference: id(3),
  configurationVersion: 2,
  lifecycle: "Draft",
  source: "StoreOverride",
  brandBaseVersionReference: id(11),
  defaultLocale: "en-CA",
  currencyCode: "CAD",
  timeZone: "America/Toronto",
  businessDayStartLocalTime: "04:00:00",
  addressReference: id(12),
  contactReference: id(13),
  receiptReference: id(14),
  taxConfigurationReference: id(15),
  paymentConfigurationReference: id(16),
  capacityConfigurationReference: null,
  enabledServiceModes: ["DineIn", "Pickup"],
  weeklySchedule: Array.from({ length: 7 }, (_, i) => ({
    isoWeekday: i + 1,
    intervals: i === 0 ? [interval(["DineIn", "Pickup"])] : [],
  })),
  exceptions: [],
  effectiveFrom: "2026-10-15T13:00:00.000Z",
  effectiveUntil: null,
  supersedesConfigurationReference: id(20),
  reasonCode: "STORE_SETUP_MATERIALIZATION",
  authoredByReference: id(4),
  approvedByReference: null,
  approvalEvidenceReference: null,
  publicationReference: null,
  liveGateEvidenceReference: null,
  createdAt: "2026-10-15T13:00:00.000Z",
  updatedAt: "2026-10-15T13:00:00.000Z",
  dataClassification: "ConfigurationMetadata",
  setupBasis: {
    profile: "StoreSetupConfigurationBasisV2",
    tenantReference: id(1),
    setupDraftReference: id(30),
    sourceRevision: 3,
    sourceSnapshotDigest: "sha256:" + "a".repeat(64),
    feeContexts: ["ServiceCharge", "DeliveryFee", "Tip"].map((chargeType) => ({
      chargeType,
      state: "Disabled",
    })),
  },
};
const configuration = (change: Record<string, unknown> = {}) =>
  createStoreConfigurationVersion({ ...base, ...change });
const { setupBasis: _basis, ...v1 } = base;
void _basis;
const current = createStoreConfigurationVersion({
  ...v1,
  configurationReference: id(20),
  configurationVersion: 1,
  lifecycle: "Published",
  supersedesConfigurationReference: null,
  effectiveFrom: "2026-10-01T04:00:00.000Z",
  createdAt: "2026-10-01T04:00:00.000Z",
  updatedAt: "2026-10-01T04:00:00.000Z",
  approvedByReference: id(5),
  approvalEvidenceReference: id(21),
  publicationReference: id(22),
  liveGateEvidenceReference: id(23),
});
const tax = {
  configurationReference: id(15),
  currencyCode: "CAD",
  evidenceValidUntil: "2026-10-20T00:00:00.000Z",
};
const facts: StoreConfigurationPublicationFacts = {
  tax,
  goLive: true,
  storePhone: true,
  ownerSetupPublished: true,
};
const outcome = (value: ReturnType<typeof evaluateStoreConfigurationPublication>) =>
  Object.fromEntries(value.checks.map((c) => [c.code, c.outcome]));
const evaluate = (
  change: Record<string, unknown> = {},
  f = facts,
  timeZone = "America/Toronto",
  live: Record<string, unknown> = {},
) =>
  evaluateStoreConfigurationPublication({
    configuration: configuration(change),
    current: createStoreConfigurationVersion({
      ...JSON.parse(JSON.stringify(current)),
      ...live,
    }),
    storeTimeZone: timeZone,
    observedAt: at,
    facts: f,
  });

describe("WP-2423 DEC-STORE-SETUP-PUBLICATION publication checks", () => {
  it("passes a Draft configuration from setup whose facts hold (Hours does not need publication)", () => {
    const checks = evaluate();
    expect(checks.checks.map((c) => c.code)).toEqual([...storeConfigurationPublicationCheckCodes]);
    expect(storeConfigurationPublicationReady(checks)).toBe(true);
  });
  it("fails each check on its own fact", () => {
    expect(outcome(evaluate({}, { ...facts, tax: null })).Tax).toBe("Fail");
    expect(
      outcome(evaluate({}, { ...facts, tax: { ...tax, configurationReference: id(99) } })).Tax,
    ).toBe("Fail");
    expect(outcome(evaluate({}, { ...facts, tax: { ...tax, evidenceValidUntil: at } })).Tax).toBe(
      "Fail",
    );
    expect(outcome(evaluate({ brandBaseVersionReference: id(98) })).BrandSettings).toBe("Fail");
    expect(outcome(evaluate({}, facts, "America/Vancouver")).TimeZone).toBe("Fail");
    expect(outcome(evaluate({ businessDayStartLocalTime: "05:00:00" })).BusinessDayStart).toBe(
      "Fail",
    );
    expect(
      outcome(
        evaluate({
          weeklySchedule: base.weeklySchedule.map((d) => ({ ...d, intervals: [] })),
        }),
      ).Hours,
    ).toBe("Fail");
    expect(
      outcome(
        evaluate({
          enabledServiceModes: ["Pickup"],
          weeklySchedule: base.weeklySchedule.map((d, i) => ({
            ...d,
            intervals: i === 0 ? [interval(["Pickup"])] : [],
          })),
          exceptions: [
            { localDate: "2026-12-25", kind: "Override", intervals: [interval(["DineIn"])] },
          ],
        }),
      ).Hours,
    ).toBe("Fail");
    expect(
      outcome(evaluate({ effectiveFrom: "2026-10-16T00:00:00.000Z", createdAt: base.createdAt }))
        .EffectiveDate,
    ).toBe("Fail");
    expect(outcome(evaluate({ effectiveFrom: "2026-09-01T00:00:00.000Z" })).EffectiveDate).toBe(
      "Fail",
    );
    expect(outcome(evaluate({ effectiveUntil: "2026-11-01T00:00:00.000Z" })).EffectiveDate).toBe(
      "Fail",
    );
    expect(outcome(evaluate({}, { ...facts, goLive: false })).GoLive).toBe("Fail");
    expect(storeConfigurationPublicationReady(evaluate({}, { ...facts, goLive: false }))).toBe(
      false,
    );
  });
  it("M109: a configuration that starts offering pickup needs the Store's published phone; one without pickup does not", () => {
    const noPhone = { ...facts, storePhone: false };
    // The Store in force is dine-in only; this configuration adds pickup.
    const dineInLive = {
      enabledServiceModes: ["DineIn"],
      weeklySchedule: base.weeklySchedule.map((d, i) => ({
        ...d,
        intervals: i === 0 ? [interval(["DineIn"])] : [],
      })),
    };
    const checks = evaluate({}, noPhone, "America/Toronto", dineInLive);
    expect(checks.profile).toBe("StoreConfigurationPublicationChecksV2");
    expect(checks.checks.at(-1)).toEqual({ code: "StorePhone", outcome: "Fail" });
    expect(storeConfigurationPublicationReady(checks)).toBe(false);
    // Every other check still passes: only the phone blocks.
    expect(checks.checks.filter((c) => c.outcome === "Fail").map((c) => c.code)).toEqual([
      "StorePhone",
    ]);
    const dineInOnly = evaluate(
      {
        enabledServiceModes: ["DineIn"],
        weeklySchedule: base.weeklySchedule.map((d, i) => ({
          ...d,
          intervals: i === 0 ? [interval(["DineIn"])] : [],
        })),
      },
      noPhone,
      "America/Toronto",
      dineInLive,
    );
    expect(outcome(dineInOnly).StorePhone).toBe("Pass");
    expect(storeConfigurationPublicationReady(dineInOnly)).toBe(true);
    expect(outcome(evaluate({}, facts, "America/Toronto", dineInLive)).StorePhone).toBe("Pass");
    // A first configuration (no Store in force yet) offering pickup needs it too.
    expect(
      outcome(
        evaluateStoreConfigurationPublication({
          configuration: configuration(),
          current: null,
          storeTimeZone: "America/Toronto",
          observedAt: at,
          facts: noPhone,
        }),
      ).StorePhone,
    ).toBe("Fail");
  });
  it("M109: a Store already offering pickup without a phone is not held up (hours and other changes)", () => {
    const checks = evaluate({}, { ...facts, storePhone: false });
    expect(outcome(checks).StorePhone).toBe("Pass");
    expect(storeConfigurationPublicationReady(checks)).toBe(true);
  });
  it("M109: a new Store's first own setup offering pickup needs the phone although the installed configuration already offers it", () => {
    const firstSetup = { ...facts, storePhone: false, ownerSetupPublished: false };
    const checks = evaluate({}, firstSetup);
    expect(outcome(checks).StorePhone).toBe("Fail");
    expect(storeConfigurationPublicationReady(checks)).toBe(false);
    expect(outcome(evaluate({}, { ...firstSetup, storePhone: true })).StorePhone).toBe("Pass");
    // An hours-only change (no setup basis) on the installed configuration is not held up.
    const hoursOnly = evaluateStoreConfigurationPublication({
      configuration: createStoreConfigurationVersion(v1),
      current,
      storeTimeZone: "America/Toronto",
      observedAt: at,
      facts: firstSetup,
    });
    expect(outcome(hoursOnly).StorePhone).toBe("Pass");
    // A first setup without pickup does not need it.
    const dineIn = {
      enabledServiceModes: ["DineIn"],
      weeklySchedule: base.weeklySchedule.map((d, i) => ({
        ...d,
        intervals: i === 0 ? [interval(["DineIn"])] : [],
      })),
    };
    expect(outcome(evaluate(dineIn, firstSetup)).StorePhone).toBe("Pass");
  });
  it("M109: still reads a V1 list (no StorePhone) saved before, and no other mix", () => {
    const v2 = evaluate();
    const v1 = {
      ...v2,
      profile: "StoreConfigurationPublicationChecksV1",
      checks: v2.checks.slice(0, -1),
    };
    expect(parseStoreConfigurationPublicationChecks(JSON.parse(JSON.stringify(v1)))).toEqual(v1);
    expect(() => parseStoreConfigurationPublicationChecks({ ...v1, checks: v2.checks })).toThrow();
    expect(() => parseStoreConfigurationPublicationChecks({ ...v2, checks: v1.checks })).toThrow();
  });
  it("parses only the closed, ordered check list", () => {
    const checks = evaluate();
    expect(parseStoreConfigurationPublicationChecks(JSON.parse(JSON.stringify(checks)))).toEqual(
      checks,
    );
    expect(() =>
      parseStoreConfigurationPublicationChecks({ ...checks, checks: checks.checks.slice(1) }),
    ).toThrow();
    expect(() =>
      parseStoreConfigurationPublicationChecks({
        ...checks,
        checks: [...checks.checks].reverse(),
      }),
    ).toThrow();
    expect(() => parseStoreConfigurationPublicationChecks({ ...checks, extra: 1 })).toThrow();
  });
  it("carries the checks of the latest configuration in the ordinary workspace", () => {
    const latest = configuration();
    const scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
    };
    const workspace = {
      profile: "StoreConfigurationOrdinaryWorkspaceV1",
      scope,
      latest,
      current,
      expectedHead: {
        configurationReference: latest.configurationReference,
        configurationVersion: 2,
        contentDigest: `sha256:${sha256Hex(canonicalizeRfc8785(latest))}`,
      },
      original: null,
      observedAt: at,
      validUntil: "2026-10-15T14:00:05.000Z",
      businessReferenceValidation: "NotEvaluated",
      publicationChecks: evaluate(),
    };
    expect(
      parseMerchantStoreConfigurationOrdinaryWorkspace(workspace, scope).publicationChecks,
    ).toEqual(evaluate());
    expect(() =>
      parseMerchantStoreConfigurationOrdinaryWorkspace(
        { ...workspace, publicationChecks: { ...evaluate(), configurationReference: id(77) } },
        scope,
      ),
    ).toThrow();
    expect(() =>
      parseMerchantStoreConfigurationOrdinaryWorkspace(
        { ...workspace, publicationChecks: undefined },
        scope,
      ),
    ).toThrow();
  });
});
