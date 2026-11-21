import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { applyCatalogProductUniqueScopeValidationV2 } from "../application/product-unique-scope-validation-v2.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
} from "../contracts/product-publication-v2.js";
import { parseCatalogProductScopeReplacementIntent } from "../contracts/product-scope-replacement-intent.js";
import { parseCatalogProductUniqueScopeAssessmentV2 } from "../contracts/product-unique-scope-v2.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
const id = (n: number) => "01902434-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T12:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function rehash(value: Record<string, unknown>) {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  return { ...body, digest: hash(body) };
}
function fixture(hard = true) {
  const selector = { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
    intent = parseCatalogProductScopeReplacementIntent(
      rehash({
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
      }),
    ),
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(4),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: hash("content"),
      configurationDigest: hash("configuration"),
      scopeSet: [selector],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_MERGE",
      replacementIntent: intent,
      replacementIntentDigest: intent.digest,
    }),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: intent.digest,
      evidenceReference: id(8),
      productAggregateVersion: command.expectedProductAggregateVersion,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: hash(command.scopeSet),
      periodDigest: hash(command.effectivePeriod),
      policyReference: id(9),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: "2026-10-02T12:00:30.000Z",
    }),
    // Synthetic held-owner assessment for the pure merge only. Real complete
    // acquisition and retirement derivation are tested by the assessor/source.
    assessment = parseCatalogProductUniqueScopeAssessmentV2(
      rehash({
        profile: "CatalogProductUniqueScopeAssessmentV2",
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(5),
        versionReference: id(6),
        aggregateVersion: 7,
        contentDigest: command.contentDigest,
        configurationDigest: command.configurationDigest,
        originalIntentDigest: hash(command),
        replacementIntentDigest: intent.digest,
        sourceDigest: hash("complete coverage"),
        sourceRevision: "7",
        sourceHeadDigest: hash("immutable heads"),
        registeredStoreDigest: hash("registered Stores"),
        policyReference: id(9),
        policyVersion: 1,
        policyContentDigest: hash("current policy"),
        policyPublicationReference: id(10),
        observedAt: at,
        validUntil: "2026-10-02T12:00:05.000Z",
        check: { code: "UniqueScope", outcome: hard ? "HardError" : "Pass" },
        findings: hard
          ? [
              {
                reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
                versionReference: id(99),
                selectorIndex: 0,
                counterpartIndex: 0,
              },
            ]
          : [],
        supportedTopology: "RegisteredBrandStoreOnly",
        equalRankResolution: "ExactStoreSelectorRetirementBound",
        sourceAuthority: "NotEvaluated",
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
      }),
    );
  return {
    command,
    validation,
    assessment,
    merge: (s: unknown = assessment, v: unknown = validation, now = at) =>
      applyCatalogProductUniqueScopeValidationV2(command, v, s, now),
  };
}
it("only replaces UniqueScope and its summary, preserving ten other checks, full V2 evidence and original deadlines", () => {
  const f = fixture(),
    before = canonicalizeRfc8785(f.validation),
    result = f.merge();
  expect(result.checks.find((check) => check.code === "UniqueScope")?.outcome).toBe("HardError");
  expect(result.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  expect(
    result.checks.filter((check) => !["UniqueScope", "HardErrorsCleared"].includes(check.code)),
  ).toEqual(
    f.validation.checks.filter(
      (check) => !["UniqueScope", "HardErrorsCleared"].includes(check.code),
    ),
  );
  expect(result.evidenceReference).toBe(f.validation.evidenceReference);
  expect(result.checkedAt).toBe(f.validation.checkedAt);
  expect(result.warningAcknowledgement).toBe(f.validation.warningAcknowledgement);
  expect(result.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
  expect(result.validUntil).toBe(f.assessment.validUntil);
  expect(canonicalizeRfc8785(f.validation)).toBe(before);
  expect(Object.isFrozen(result.checks)).toBe(true);
  expect(
    f.merge(undefined, { ...f.validation, validUntil: "2026-10-02T12:00:02.000Z" }).validUntil,
  ).toBe("2026-10-02T12:00:02.000Z");
});
it("cannot clear another hard error or manufacture incomplete validation", () => {
  const f = fixture(false),
    v = {
      ...f.validation,
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome: ["MediaReady", "HardErrorsCleared"].includes(check.code) ? "HardError" : "Pass",
      })),
    },
    result = f.merge(undefined, v);
  expect(result.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  expect(() => f.merge(undefined, { ...f.validation, checks: [] })).toThrow();
  expect(() =>
    f.merge(undefined, {
      ...f.validation,
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome: ["UniqueScope", "HardErrorsCleared"].includes(check.code) ? "HardError" : "Pass",
      })),
    }),
  ).toThrow();
});
it("binds the scope resolution mode even when its full intent and assessment digests are valid", () => {
  const f = fixture(false),
    none = rehash({ profile: "CatalogProductNoReplacementIntentV1", mode: "None" }),
    command = parseProductPublicationCommandV2({
      ...f.command,
      replacementIntent: none,
      replacementIntentDigest: none.digest,
    }),
    validation = parseProductPublicationValidationV2({
      ...f.validation,
      replacementIntentDigest: none.digest,
    }),
    assessment = rehash({
      ...f.assessment,
      originalIntentDigest: hash(command),
      replacementIntentDigest: none.digest,
      equalRankResolution: "NoReplacementRequested",
    });
  expect(
    applyCatalogProductUniqueScopeValidationV2(command, validation, assessment, at).checks,
  ).toEqual(f.validation.checks);
  expect(() =>
    applyCatalogProductUniqueScopeValidationV2(
      command,
      validation,
      rehash({ ...assessment, equalRankResolution: "ExactStoreSelectorRetirementBound" }),
      at,
    ),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
  expect(() =>
    f.merge(rehash({ ...f.assessment, equalRankResolution: "NoReplacementRequested" })),
  ).toThrow(expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }));
});
it.each(["Pass", "Warning", "HardError"] as const)(
  "preserves approval Pending and independent %s through exact scope assessment",
  (outcome) => {
    for (const scopeHard of [false, true]) {
      const f = fixture(scopeHard),
        pending = parseProductPublicationValidationV2({
          ...f.validation,
          validUntil: "2026-10-02T12:00:02.000Z",
          checks: f.validation.checks.map((check) => ({
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
                  actorReference: f.command.actorReference,
                  reasonCode: "SYNTHETIC_TECHNICAL_WARNING",
                  warningCodes: ["TaxResolution"],
                }
              : null,
        }),
        result = f.merge(undefined, pending);
      expect(result.checks.find((check) => check.code === "ApprovalPolicy")?.outcome).toBe(
        "Pending",
      );
      expect(result.checks.find((check) => check.code === "TaxResolution")?.outcome).toBe(outcome);
      expect(result.checks.find((check) => check.code === "UniqueScope")?.outcome).toBe(
        scopeHard ? "HardError" : "Pass",
      );
      expect(result.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe(
        scopeHard || outcome === "HardError" ? "HardError" : "Pass",
      );
      expect(result.evidenceReference).toBe(pending.evidenceReference);
      expect(result.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
      expect(result.validUntil).toBe(pending.validUntil);
      expect(result.warningAcknowledgement).toEqual(pending.warningAcknowledgement);
      expect(() =>
        f.merge(undefined, {
          ...pending,
          warningAcknowledgement: {
            actorReference: f.command.actorReference,
            reasonCode: "SYNTHETIC_FORBIDDEN_OVERRIDE",
            warningCodes: ["ApprovalPolicy"],
          },
        }),
      ).toThrow();
    }
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "productReference",
  "versionReference",
  "contentDigest",
  "configurationDigest",
  "originalIntentDigest",
  "replacementIntentDigest",
  "policyReference",
  "aggregateVersion",
  "policyVersion",
])("rejects a correctly rehashed but foreign %s", (key) => {
  const f = fixture(),
    value = key.endsWith("Digest") ? hash("different") : key.endsWith("Version") ? 8 : id(999);
  expect(() => f.merge(rehash({ ...f.assessment, [key]: value }))).toThrow();
});
it.each([
  "sourceDigest",
  "sourceRevision",
  "sourceHeadDigest",
  "registeredStoreDigest",
  "policyContentDigest",
  "policyPublicationReference",
])("detects detached assessment integrity tampering of %s", (key) => {
  const f = fixture();
  expect(() =>
    f.merge({ ...f.assessment, [key]: key.endsWith("Digest") ? hash("wrong") : "99" }),
  ).toThrow();
});
it("rejects changed full commands, target evidence and V1 evidence even when scope bytes stay equal", () => {
  const f = fixture();
  expect(() =>
    applyCatalogProductUniqueScopeValidationV2(
      { ...f.command, operationReference: id(999) },
      f.validation,
      f.assessment,
      at,
    ),
  ).toThrow();
  expect(() =>
    applyCatalogProductUniqueScopeValidationV2(
      { ...f.command, action: "SubmitReview" },
      f.validation,
      f.assessment,
      at,
    ),
  ).toThrow();
  const intent = parseCatalogProductScopeReplacementIntent(
    rehash({ ...f.command.replacementIntent, previousVersionReference: id(999) }),
  );
  expect(() =>
    applyCatalogProductUniqueScopeValidationV2(
      { ...f.command, replacementIntent: intent, replacementIntentDigest: intent.digest },
      f.validation,
      f.assessment,
      at,
    ),
  ).toThrow();
  expect(() =>
    f.merge(undefined, { ...f.validation, replacementIntentDigest: hash("another target") }),
  ).toThrow();
  const v1 = Object.fromEntries(
    Object.entries(f.validation).filter(
      ([key]) => !["profile", "replacementIntentDigest"].includes(key),
    ),
  );
  expect(() => f.merge(undefined, v1)).toThrow();
});
it.each(["2026-10-02T11:59:59.999Z", "2026-10-02T12:00:05.000Z"])(
  "refuses the original clock boundary %s",
  (now) => {
    expect(() => fixture().merge(undefined, undefined, now)).toThrow();
  },
);
it("refuses partial binding, extra keys and accessors without invoking code", () => {
  const f = fixture(),
    get = vi.fn();
  expect(() => f.merge({ check: f.assessment.check })).toThrow();
  expect(() => f.merge(rehash({ ...f.assessment, exemptions: [] }))).toThrow();
  expect(() =>
    f.merge(Object.defineProperty({ ...f.assessment }, "findings", { get, enumerable: true })),
  ).toThrow();
  expect(() =>
    applyCatalogProductUniqueScopeValidationV2(
      Object.defineProperty({ ...f.command }, "replacementIntent", { get, enumerable: true }),
      f.validation,
      f.assessment,
      at,
    ),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
});
