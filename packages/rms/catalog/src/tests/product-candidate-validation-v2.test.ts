import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  applyCatalogProductCandidateValidationV2,
  type ProductCandidateValidationBindingV2,
} from "../application/product-candidate-validation.js";
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
function fixture(hard = false) {
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
  const candidate: ProductCandidateValidationBindingV2 = {
    profile: "CatalogProductCandidateValidationBindingV2",
    scopeAssessment: assessment,
    candidateObservedAt: at,
    candidateValidUntil: "2026-10-02T12:00:30.000Z",
    validUntil: "2026-10-02T12:00:03.000Z",
    skuPrerequisite: "ActiveMemberPresent",
    variantMappingPrerequisite: "NoExplicitUnmappedCombination",
    optionSelectionPrerequisite: "NoExplicitDefaultBoundsViolation",
    optionRulePrerequisite: "NoMechanicalContradiction",
    internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
  };
  return {
    command,
    validation,
    assessment,
    candidate,
    merge: (
      s: ProductCandidateValidationBindingV2 = candidate,
      v: unknown = validation,
      now = at,
    ) => applyCatalogProductCandidateValidationV2(command, v, s, now),
  };
}
it("retains the original joined deadline, complete target and all independent outcomes", () => {
  const f = fixture(),
    before = canonicalizeRfc8785(f.assessment),
    result = f.merge();
  expect(result).toEqual(
    parseProductPublicationValidationV2({ ...f.validation, validUntil: f.candidate.validUntil }),
  );
  expect(canonicalizeRfc8785(f.assessment)).toBe(before);
  expect(result.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
  expect(Object.isFrozen(result.checks)).toBe(true);
});
it.each(["Pass", "Warning", "HardError"] as const)(
  "preserves pending approval alongside independent %s and new candidate failures",
  (outcome) => {
    const f = fixture(),
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
    expect(result.checks).toEqual(pending.checks);
    expect(result.validUntil).toBe(pending.validUntil);
    expect(result.evidenceReference).toBe(pending.evidenceReference);
    expect(result.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
    expect(result.warningAcknowledgement).toEqual(pending.warningAcknowledgement);
    const failed = f.merge({ ...f.candidate, optionRulePrerequisite: "Unsatisfiable" }, pending);
    expect(failed.checks.find((check) => check.code === "ApprovalPolicy")?.outcome).toBe("Pending");
    expect(failed.checks.find((check) => check.code === "TaxResolution")?.outcome).toBe(outcome);
    expect(failed.checks.find((check) => check.code === "OptionSelection")?.outcome).toBe(
      "HardError",
    );
    expect(failed.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe(
      "HardError",
    );
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
  },
);
it.each([
  ["skuPrerequisite", "NoActiveMember", "PublishableSku"],
  ["variantMappingPrerequisite", "UnmappedCombinationPresent", "VariantMapping"],
  ["optionSelectionPrerequisite", "ExplicitDefaultBoundsViolated", "OptionSelection"],
  ["optionRulePrerequisite", "Unsatisfiable", "OptionSelection"],
] as const)("adds only the necessary %s failure", (key, value, code) => {
  const f = fixture(),
    result = f.merge({ ...f.candidate, [key]: value });
  expect(result.checks.find((check) => check.code === code)?.outcome).toBe("HardError");
  expect(result.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  expect(
    result.checks.filter((check) => ![code, "HardErrorsCleared"].includes(check.code)),
  ).toEqual(
    f.validation.checks.filter((check) => ![code, "HardErrorsCleared"].includes(check.code)),
  );
  expect(result.evidenceReference).toBe(f.validation.evidenceReference);
});
it.each(["Warning", "HardError"] as const)(
  "never promotes independent %s from positive necessary facts",
  (outcome) => {
    const f = fixture(),
      checks = f.validation.checks.map((check) => ({
        ...check,
        outcome: ["PublishableSku", "VariantMapping", "OptionSelection"].includes(check.code)
          ? outcome
          : check.code === "HardErrorsCleared" && outcome === "HardError"
            ? "HardError"
            : "Pass",
      })),
      v = parseProductPublicationValidationV2({ ...f.validation, checks });
    expect(f.merge(undefined, v).checks).toEqual(v.checks);
  },
);
it("requires actual InternalCode placeholder and preserves unrelated warning attribution", () => {
  const f = fixture(),
    v = parseProductPublicationValidationV2({
      ...f.validation,
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome: check.code === "MediaReady" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "SYNTHETIC",
        warningCodes: ["MediaReady"],
      },
    }),
    result = f.merge(
      { ...f.candidate, internalCodeCheck: { code: "InternalCode", outcome: "HardError" } },
      v,
    );
  expect(result.warningAcknowledgement).toEqual(v.warningAcknowledgement);
  expect(result.checks.find((check) => check.code === "InternalCode")?.outcome).toBe("HardError");
  const bad = {
    ...v,
    checks: v.checks.map((check) => ({
      ...check,
      outcome: ["InternalCode", "HardErrorsCleared"].includes(check.code)
        ? "HardError"
        : check.outcome,
    })),
  };
  expect(() => f.merge(undefined, bad)).toThrow();
  const acknowledged = {
    ...f.validation,
    checks: f.validation.checks.map((check) => ({
      ...check,
      outcome: check.code === "OptionSelection" ? "Warning" : "Pass",
    })),
    warningAcknowledgement: {
      actorReference: id(3),
      reasonCode: "SYNTHETIC",
      warningCodes: ["OptionSelection"],
    },
  };
  expect(() =>
    f.merge({ ...f.candidate, optionRulePrerequisite: "Unsatisfiable" }, acknowledged),
  ).toThrow();
});
it("applies the half-open period at current validation time without clearing independent failures", () => {
  const f = fixture(),
    end = "2026-10-02T12:00:01.000Z",
    command = parseProductPublicationCommandV2({
      ...f.command,
      effectivePeriod: {
        ...f.command.effectivePeriod,
        effectiveUntil: { instant: end, localDateTime: end.slice(0, 23), utcOffsetMinutes: 0 },
      },
    }),
    candidate = {
      ...f.candidate,
      scopeAssessment: parseCatalogProductUniqueScopeAssessmentV2(
        rehash({ ...f.assessment, originalIntentDigest: hash(command) }),
      ),
    },
    validation = { ...f.validation, periodDigest: hash(command.effectivePeriod) },
    result = applyCatalogProductCandidateValidationV2(command, validation, candidate, end);
  expect(result.checks.find((check) => check.code === "EffectivePeriod")?.outcome).toBe(
    "HardError",
  );
});
it.each([
  "profile",
  "target",
  "command",
  "scopeDigest",
  "deadline",
  "candidateClock",
  "candidateLease",
  "expired",
  "incomplete",
  "optionAbsent",
])("rejects broken V2 binding %s", (mode) => {
  const f = fixture();
  let candidate: ProductCandidateValidationBindingV2 = f.candidate,
    validation: unknown = f.validation,
    now = at;
  if (mode === "profile") candidate = { ...candidate, profile: "V1" } as never;
  if (mode === "target") validation = { ...f.validation, replacementIntentDigest: hash("another") };
  if (mode === "command")
    candidate = {
      ...candidate,
      scopeAssessment: parseCatalogProductUniqueScopeAssessmentV2(
        rehash({ ...f.assessment, originalIntentDigest: hash("another") }),
      ),
    };
  if (mode === "scopeDigest")
    candidate = { ...candidate, scopeAssessment: { ...f.assessment, digest: hash("wrong") } };
  if (mode === "deadline") candidate = { ...candidate, validUntil: "2026-10-02T12:00:06.000Z" };
  if (mode === "candidateClock")
    candidate = { ...candidate, candidateObservedAt: "2026-10-02T12:00:01.000Z" };
  if (mode === "candidateLease")
    candidate = { ...candidate, candidateValidUntil: "2026-10-02T12:00:30.001Z" };
  if (mode === "expired") now = candidate.validUntil;
  if (mode === "incomplete") validation = { ...f.validation, checks: [] };
  if (mode === "optionAbsent")
    candidate = { ...candidate, optionRulePrerequisite: undefined } as never;
  expect(() => f.merge(candidate, validation, now)).toThrow();
});
it("rejects extra packet fields and getters without calling them", () => {
  const f = fixture(),
    get = vi.fn();
  expect(() => f.merge({ ...f.candidate, sourceExemptions: [] } as never)).toThrow();
  expect(() =>
    f.merge(
      Object.defineProperty({ ...f.candidate }, "optionRulePrerequisite", {
        get,
        enumerable: true,
      }),
    ),
  ).toThrow();
  expect(() =>
    f.merge(
      Object.defineProperty({ ...f.candidate }, "scopeAssessment", { get, enumerable: true }),
    ),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
});
