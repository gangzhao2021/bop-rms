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
};
const outcome = (value: ReturnType<typeof evaluateStoreConfigurationPublication>) =>
  Object.fromEntries(value.checks.map((c) => [c.code, c.outcome]));
const evaluate = (change: Record<string, unknown> = {}, f = facts, timeZone = "America/Toronto") =>
  evaluateStoreConfigurationPublication({
    configuration: configuration(change),
    current: createStoreConfigurationVersion(JSON.parse(JSON.stringify(current))),
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
