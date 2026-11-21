import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { applyCatalogProductContentPolicyValidationV2 } from "../application/product-content-policy-validation.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
} from "../contracts/product-publication-v2.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import type { CatalogProductContentPolicyAssessmentV2 } from "../contracts/product-content-policy.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T15:00:00.000Z",
  plus = (n: number) => new Date(Date.parse(at) + n * 1000).toISOString(),
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const selector = { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
    target = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 3,
      previousIntentDigest: hash("old intent"),
      previousScopeDigest: hash("old scope"),
      previousPeriodDigest: hash("old period"),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    intent = { ...target, digest: hash(target) };
  const c = parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    replacementIntent: intent,
    replacementIntentDigest: intent.digest,
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
    scopeSet: [selector],
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
  const v = parseProductPublicationValidationV2({
    profile: "CatalogProductPublicationValidationV2",
    replacementIntentDigest: intent.digest,
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
    profile: "CatalogProductContentPolicyAssessmentV2",
    replacementIntentDigest: c.replacementIntentDigest,
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
    return { ...b, digest: hash(b) } as unknown as CatalogProductContentPolicyAssessmentV2;
  };
  const run = (patch: Record<string, unknown> = {}, validation: unknown = v, now = at) =>
    applyCatalogProductContentPolicyValidationV2(c, validation, assessment(patch), now);
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
  "does not promote pending approval or independent %s after positive content assessment",
  (outcome) => {
    const f = fixture(),
      pending = parseProductPublicationValidationV2({
        ...f.v,
        validUntil: plus(2),
        checks: f.v.checks.map((check) => ({
          ...check,
          outcome:
            check.code === "ApprovalPolicy"
              ? "Pending"
              : check.code === "TaxResolution"
                ? outcome
                : check.code === "HardErrorsCleared" && outcome === "HardError"
                  ? "HardError"
                  : check.outcome,
        })),
        warningAcknowledgement:
          outcome === "Warning"
            ? {
                actorReference: f.c.actorReference,
                reasonCode: "SYNTHETIC_TECHNICAL_WARNING",
                warningCodes: ["TaxResolution"],
              }
            : null,
      }),
      result = f.run({ warningOverrideAllowed: true }, pending);
    expect(result.checks).toEqual(pending.checks);
    expect(result.validUntil).toBe(pending.validUntil);
    expect(result.evidenceReference).toBe(pending.evidenceReference);
    expect(result.replacementIntentDigest).toBe(f.c.replacementIntentDigest);
    expect(result.warningAcknowledgement).toEqual(pending.warningAcknowledgement);
    const failed = f.run(
      { ...f.failure("RequiredMediaPresence"), warningOverrideAllowed: true },
      pending,
    );
    expect(failed.checks.find((check) => check.code === "ApprovalPolicy")?.outcome).toBe("Pending");
    expect(failed.checks.find((check) => check.code === "TaxResolution")?.outcome).toBe(outcome);
    expect(failed.checks.find((check) => check.code === "MediaReady")?.outcome).toBe("HardError");
    expect(failed.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe(
      "HardError",
    );
    expect(() =>
      f.run(
        { warningOverrideAllowed: true },
        {
          ...pending,
          warningAcknowledgement: {
            actorReference: f.c.actorReference,
            reasonCode: "SYNTHETIC_FORBIDDEN_OVERRIDE",
            warningCodes: ["ApprovalPolicy"],
          },
        },
      ),
    ).toThrow();
  },
);
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
  expect(() => applyCatalogProductContentPolicyValidationV2(f.c, f.v, a, at)).toThrow();
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
    applyCatalogProductContentPolicyValidationV2(
      { ...f.c, action: "SubmitReview" },
      f.v,
      f.assessment(),
      at,
    ),
  ).toThrow();
});

it("rejects another permanent target and full operation while preserving unchanged scope bytes", () => {
  const f = fixture();
  expect(() => f.run({ replacementIntentDigest: hash("another target") })).toThrow();
  expect(() =>
    applyCatalogProductContentPolicyValidationV2(
      { ...f.c, operationReference: id(99) },
      f.v,
      f.assessment(),
      at,
    ),
  ).toThrow();
  expect(() => f.run({}, { ...f.v, replacementIntentDigest: hash("another target") })).toThrow();
});
it("refuses an expired full receipt even while the content policy source remains current", () => {
  const f = fixture();
  expect(() => f.run({}, { ...f.v, validUntil: plus(1) }, plus(1))).toThrow();
});
it("rejects V1 evidence and V1 assessment through the explicit V2 merge", () => {
  const f = fixture(),
    v1 = Object.fromEntries(
      Object.entries(f.v).filter(([key]) => !["profile", "replacementIntentDigest"].includes(key)),
    );
  expect(() => f.run({}, v1)).toThrow();
  expect(() => f.run({ profile: "CatalogProductContentPolicyAssessmentV1" })).toThrow();
});
