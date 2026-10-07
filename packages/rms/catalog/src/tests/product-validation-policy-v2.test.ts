import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  bindCatalogProductValidationToPolicy,
  bindCatalogProductValidationToPolicyV2,
} from "../contracts/product-validation-policy.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
} from "../contracts/product-publication-v2.js";
import {
  productPublicationCheckCodes,
  parseProductPublicationValidation,
} from "../contracts/product-publication.js";
const id = (n: number) => "01902435-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T10:00:00.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const selector = { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
    body = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 3,
      previousIntentDigest: hash("old command"),
      previousScopeDigest: hash("old scope"),
      previousPeriodDigest: hash("old period"),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    intent = { ...body, digest: hash(body) },
    command = parseProductPublicationCommandV2({
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
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
    }),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: intent.digest,
      evidenceReference: id(7),
      productAggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: hash(command.scopeSet),
      periodDigest: hash(command.effectivePeriod),
      policyReference: id(8),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: "2026-10-03T10:00:20.000Z",
    }),
    policy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(9),
      policyReference: id(8),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: null,
    };
  return { command, validation, policy };
}
it.each(["Required", "NotRequired"])(
  "retains every V2 outcome, target and original evidence for %s",
  (approvalPolicy) => {
    const f = fixture(),
      validation = parseProductPublicationValidationV2({
        ...f.validation,
        approvalPolicy,
        checks: f.validation.checks.map((check) => ({
          ...check,
          outcome: ["MediaReady", "ApprovalPolicy", "HardErrorsCleared"].includes(check.code)
            ? "HardError"
            : "Pass",
        })),
      }),
      result = bindCatalogProductValidationToPolicyV2(f.command, validation, {
        ...f.policy,
        approvalPolicy,
      });
    expect(canonicalizeRfc8785(result)).toBe(canonicalizeRfc8785(validation));
    expect(Object.isFrozen(result.checks)).toBe(true);
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "policyReference",
  "policyVersion",
  "approvalPolicy",
])("refuses changed current policy %s", (key) => {
  const f = fixture();
  expect(() =>
    bindCatalogProductValidationToPolicyV2(f.command, f.validation, {
      ...f.policy,
      [key]: key === "policyVersion" ? 2 : key === "approvalPolicy" ? "NotRequired" : id(99),
    }),
  ).toThrow();
});
it.each([
  "replacementIntentDigest",
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "productAggregateVersion",
])("refuses changed command/evidence %s", (key) => {
  const f = fixture();
  expect(() =>
    bindCatalogProductValidationToPolicyV2(
      f.command,
      { ...f.validation, [key]: key === "productAggregateVersion" ? 2 : hash("another target") },
      f.policy,
    ),
  ).toThrow();
});
it("keeps warning actor/reason and refuses a forbidden acknowledgement", () => {
  const f = fixture(),
    warning = {
      ...f.validation,
      checks: f.validation.checks.map((c) => ({
        ...c,
        outcome: c.code === "MediaReady" ? "Warning" : "Pass",
      })),
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "SYNTHETIC_REVIEW",
        warningCodes: ["MediaReady"],
      },
    };
  expect(() => bindCatalogProductValidationToPolicyV2(f.command, warning, f.policy)).toThrow();
  expect(
    bindCatalogProductValidationToPolicyV2(f.command, warning, {
      ...f.policy,
      warningOverrideAllowed: true,
    }).warningAcknowledgement,
  ).toEqual(warning.warningAcknowledgement);
});
it("keeps the V1 binder closed and byte-identical and rejects missing V2 fields/getters", () => {
  const f = fixture(),
    legacy = Object.fromEntries(
      Object.entries(f.validation).filter(
        ([key]) => !["profile", "replacementIntentDigest"].includes(key),
      ),
    ),
    context = { tenantReference: id(1), brandReference: id(2) };
  expect(bindCatalogProductValidationToPolicy(legacy, f.policy, context)).toEqual(
    parseProductPublicationValidation(legacy),
  );
  expect(() => bindCatalogProductValidationToPolicy(f.validation, f.policy, context)).toThrow();
  expect(() => bindCatalogProductValidationToPolicyV2(f.command, legacy, f.policy)).toThrow();
  expect(() =>
    bindCatalogProductValidationToPolicyV2({ ...f.command, extra: true }, f.validation, f.policy),
  ).toThrow();
  const get = vi.fn();
  expect(() =>
    bindCatalogProductValidationToPolicyV2(
      Object.defineProperty({ ...f.command }, "replacementIntent", { get, enumerable: true }),
      f.validation,
      f.policy,
    ),
  ).toThrow();
  expect(() =>
    bindCatalogProductValidationToPolicyV2(
      f.command,
      f.validation,
      Object.defineProperty({ ...f.policy }, "warningOverrideAllowed", { get, enumerable: true }),
    ),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
});
it("retains Required approval Pending and separately acknowledged warnings without changing evidence or expiry", () => {
  const f = fixture(),
    pending = parseProductPublicationValidationV2({
      ...f.validation,
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome:
          check.code === "ApprovalPolicy"
            ? "Pending"
            : check.code === "TaxResolution"
              ? "Warning"
              : check.outcome,
      })),
      warningAcknowledgement: {
        actorReference: f.command.actorReference,
        reasonCode: "SYNTHETIC_TECHNICAL_WARNING",
        warningCodes: ["TaxResolution"],
      },
    }),
    policy = { ...f.policy, warningOverrideAllowed: true },
    result = bindCatalogProductValidationToPolicyV2(f.command, pending, policy);
  expect(canonicalizeRfc8785(result)).toBe(canonicalizeRfc8785(pending));
  expect(result.checks.find((check) => check.code === "ApprovalPolicy")?.outcome).toBe("Pending");
  expect(result.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe("Pass");
  expect(() =>
    bindCatalogProductValidationToPolicyV2(
      f.command,
      {
        ...pending,
        warningAcknowledgement: {
          ...pending.warningAcknowledgement,
          warningCodes: ["ApprovalPolicy", "TaxResolution"],
        },
      },
      policy,
    ),
  ).toThrow();
  expect(() =>
    bindCatalogProductValidationToPolicyV2(
      f.command,
      {
        ...pending,
        approvalPolicy: "NotRequired",
      },
      { ...policy, approvalPolicy: "NotRequired" },
    ),
  ).toThrow();
  const legacyPending = Object.fromEntries(
    Object.entries(pending).filter(
      ([key]) => !["profile", "replacementIntentDigest"].includes(key),
    ),
  );
  expect(() =>
    bindCatalogProductValidationToPolicy(legacyPending, policy, {
      tenantReference: f.command.tenantReference,
      brandReference: f.command.brandReference,
    }),
  ).toThrow();
});
