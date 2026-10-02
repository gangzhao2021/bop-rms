import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  applyCatalogProductContentPolicyValidation,
  parseProductPublicationCommand,
  parseProductPublicationValidation,
  productPublicationCheckCodes,
  type CatalogProductContentPolicyAssessment,
} from "../index.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T15:00:00.000Z",
  plus = (n: number) => new Date(Date.parse(at) + n * 1000).toISOString(),
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const c = parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: hash("content"),
    configurationDigest: hash("config"),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  });
  const v = parseProductPublicationValidation({
    evidenceReference: id(7),
    productAggregateVersion: 1,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    policyReference: id(8),
    policyVersion: 1,
    approvalPolicy: "Required",
    checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: plus(20),
  });
  const body = {
    profile: "CatalogProductContentPolicyAssessmentV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    versionReference: id(6),
    aggregateVersion: 1,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    originalIntentDigest: hash(c),
    observedAt: at,
    validUntil: plus(3),
    brandSource: {
      brandVersion: 1,
      configurationVersionReference: id(9),
      contentDigest: hash("brand"),
      currentPublicationReference: id(10),
    },
    policyReference: id(8),
    policyVersion: 1,
    policyContentDigest: hash("policy"),
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    checks: [
      "SupportedLocales",
      "RequiredProductNames",
      "CompleteContent",
      "RequiredMediaPresence",
    ].map((code) => ({ code, outcome: "Pass" })),
    decision: "PassForAssessedRules",
    sourceAuthority: "NotEvaluated",
    publishValidation: "Incomplete",
    mediaReadiness: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    brandFieldRequirements: "NotEvaluated",
    eligibility: "NotEvaluated",
  };
  const assessment = (patch: Record<string, unknown> = {}) => {
    const b = { ...body, ...patch };
    return { ...b, digest: hash(b) } as unknown as CatalogProductContentPolicyAssessment;
  };
  const run = (patch: Record<string, unknown> = {}, validation: unknown = v, now = at) =>
    applyCatalogProductContentPolicyValidation(c, validation, assessment(patch), now);
  const failure = (code: string) => ({
    checks: body.checks.map((check) => ({
      ...check,
      outcome: check.code === code ? "HardError" : "Pass",
    })),
    decision: "HardError",
  });
  return { c, v, body, assessment, run, failure };
}
it.each(["SupportedLocales", "RequiredProductNames"])(
  "current %s failure overrides a supplied name Pass",
  (code) => {
    const f = fixture(),
      r = f.run(f.failure(code));
    expect(r.checks.find((c) => c.code === "DefaultLocaleName")?.outcome).toBe("HardError");
    expect(r.checks.find((c) => c.code === "HardErrorsCleared")?.outcome).toBe("HardError");
    expect(r.checks.find((c) => c.code === "MediaReady")?.outcome).toBe("Pass");
    expect(r.evidenceReference).toBe(f.v.evidenceReference);
    expect(r.validUntil).toBe(f.body.validUntil);
  },
);
it("mandatory missing Media overrides independent Pass without manufacturing readiness", () => {
  const f = fixture(),
    r = f.run(f.failure("RequiredMediaPresence"));
  expect(r.checks.find((c) => c.code === "MediaReady")?.outcome).toBe("HardError");
  expect(r.checks.find((c) => c.code === "DefaultLocaleName")?.outcome).toBe("Pass");
});
it.each(["Pass", "Warning", "HardError"] as const)(
  "partial success preserves independent %s and Actor/Reason",
  (outcome) => {
    const f = fixture(),
      v = {
        ...f.v,
        checks: f.v.checks.map((c) => ({
          ...c,
          outcome: ["DefaultLocaleName", "MediaReady"].includes(c.code)
            ? outcome
            : c.code === "HardErrorsCleared" && outcome === "HardError"
              ? "HardError"
              : "Pass",
        })),
        warningAcknowledgement:
          outcome === "Warning"
            ? {
                actorReference: f.c.actorReference,
                reasonCode: "SYNTHETIC",
                warningCodes: ["DefaultLocaleName", "MediaReady"],
              }
            : null,
      },
      r = f.run({}, v);
    expect(r.checks.find((c) => c.code === "MediaReady")?.outcome).toBe(outcome);
    expect(r.checks.find((c) => c.code === "DefaultLocaleName")?.outcome).toBe(outcome);
    expect(r.warningAcknowledgement).toEqual(v.warningAcknowledgement);
  },
);
it("never rewrites an acknowledged Warning into HardError override", () => {
  const f = fixture(),
    v = {
      ...f.v,
      checks: f.v.checks.map((c) => ({
        ...c,
        outcome: c.code === "MediaReady" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: {
        actorReference: f.c.actorReference,
        reasonCode: "SYNTHETIC",
        warningCodes: ["MediaReady"],
      },
    };
  expect(() => f.run(f.failure("RequiredMediaPresence"), v)).toThrow();
});
it.each([
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "policyReference",
  "policyVersion",
  "aggregateVersion",
])("refuses foreign %s even with consistent supplied digest", (key) =>
  expect(() => fixture().run({ [key]: key.endsWith("Version") ? 2 : id(99) })).toThrow(),
);
it.each([
  "sourceAuthority",
  "mediaReadiness",
  "referenceEligibility",
  "brandFieldRequirements",
  "eligibility",
])("qualification-like %s is unavailable", (key) =>
  expect(() => fixture().run({ [key]: "Ready" })).toThrow(),
);
it.each([plus(3), new Date(Date.parse(at) - 1).toISOString()])(
  "exclusive expiry/future %s refuses",
  (now) => expect(() => fixture().run({}, undefined, now)).toThrow(),
);
it("unknown/missing checks, incomplete content, inconsistent decision and extra fields refuse", () => {
  const f = fixture();
  for (const p of [
    { checks: [] },
    { checks: [...f.body.checks, { code: "Unknown", outcome: "Pass" }] },
    f.failure("CompleteContent"),
    { decision: "HardError" },
    { extra: true },
    { brandSource: { ...f.body.brandSource, extra: true } },
    { policyContentDigest: "invalid" },
  ])
    expect(() => f.run(p)).toThrow();
});
it("accessors never execute and cannot replace current assessment", () => {
  const f = fixture(),
    get = vi.fn(),
    a = Object.defineProperty({ ...f.assessment() }, "checks", { get, enumerable: true });
  expect(() => applyCatalogProductContentPolicyValidation(f.c, f.v, a, at)).toThrow();
  expect(get).not.toHaveBeenCalled();
});
it("content-policy proof cannot bind a different period, scope, receipt or action", () => {
  const f = fixture();
  for (const p of [
    { scopeDigest: hash("other") },
    { periodDigest: hash("other") },
    { checkedAt: plus(1) },
    { contentDigest: hash("other") },
  ])
    expect(() => f.run({}, { ...f.v, ...p })).toThrow();
  expect(() =>
    applyCatalogProductContentPolicyValidation(
      { ...f.c, action: "SubmitReview" },
      f.v,
      f.assessment(),
      at,
    ),
  ).toThrow();
});
