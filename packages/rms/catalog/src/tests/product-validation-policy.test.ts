import { expect, it, vi } from "vitest";
import { bindCatalogProductValidationToPolicy } from "../contracts/product-validation-policy.js";
import {
  productPublicationCheckCodes,
  parseProductPublicationValidation,
} from "../contracts/product-publication.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T11:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
function fixture() {
  const context = { tenantReference: id(1), brandReference: id(2) };
  const policy = {
    profile: "PublishingProductPublicationPolicyV1",
    ...context,
    familyReference: id(20),
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
  const validation = {
    evidenceReference: id(7),
    productAggregateVersion: 1,
    contentDigest: hash,
    configurationDigest: hash,
    scopeDigest: hash,
    periodDigest: hash,
    policyReference: id(8),
    policyVersion: 1,
    approvalPolicy: "Required",
    checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
    warningAcknowledgement: null as unknown,
    checkedAt: at,
    validUntil: "2026-10-02T11:00:30.000Z",
  };
  return {
    context,
    policy,
    validation,
    bind: () => bindCatalogProductValidationToPolicy(validation, policy, context),
  };
}
for (const approval of ["Required", "NotRequired"])
  it("preserves all twelve outcomes and evidence for " + approval, () => {
    const f = fixture();
    f.validation.approvalPolicy = f.policy.approvalPolicy = approval;
    expect(f.bind()).toEqual(parseProductPublicationValidation(f.validation));
    expect(Object.isFrozen(f.bind())).toBe(true);
  });
for (const acknowledged of [true, false])
  for (const allowed of [true, false])
    it(`policy allows=${allowed}, warning acknowledged=${acknowledged}`, () => {
      const f = fixture();
      f.policy.warningOverrideAllowed = allowed;
      f.validation.checks = f.validation.checks.map((c) => ({
        ...c,
        outcome: c.code === "MediaReady" ? "Warning" : "Pass",
      }));
      if (acknowledged)
        f.validation.warningAcknowledgement = {
          actorReference: id(3),
          reasonCode: "SYNTHETIC_WARNING",
          warningCodes: ["MediaReady"],
        };
      if (acknowledged && !allowed)
        expect(f.bind).toThrowError(
          expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
        );
      else expect(f.bind()).toEqual(parseProductPublicationValidation(f.validation));
    });
it("never clears HardError or manufactures required approval Pass", () => {
  const f = fixture();
  f.policy.warningOverrideAllowed = true;
  f.validation.checks = f.validation.checks.map((c) => ({
    ...c,
    outcome: ["MediaReady", "ApprovalPolicy", "HardErrorsCleared"].includes(c.code)
      ? "HardError"
      : "Pass",
  }));
  expect(f.bind()).toEqual(parseProductPublicationValidation(f.validation));
});
for (const key of [
  "tenantReference",
  "brandReference",
  "policyReference",
  "policyVersion",
  "approvalPolicy",
] as const)
  it("refuses changed owning policy " + key, () => {
    const f = fixture();
    Object.assign(f.policy, {
      [key]: key === "policyVersion" ? 2 : key === "approvalPolicy" ? "NotRequired" : id(99),
    });
    expect(f.bind).toThrowError(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  });
it("refuses incomplete checks, unknown scope, nonboolean policy and mismatched acknowledgement", () => {
  for (const mode of ["checks", "scope", "policy", "ack"]) {
    const f = fixture();
    if (mode === "checks") f.validation.checks.pop();
    if (mode === "scope") Object.assign(f.context, { extra: true });
    if (mode === "policy") Object.assign(f.policy, { warningOverrideAllowed: "true" });
    if (mode === "ack")
      f.validation.warningAcknowledgement = {
        actorReference: id(3),
        reasonCode: "SYNTHETIC_WARNING",
        warningCodes: ["MediaReady"],
      };
    expect(f.bind).toThrow();
  }
});
it("does not invoke source/context/validation accessors", () => {
  for (const key of ["policy", "context", "validation"] as const) {
    const f = fixture(),
      get = vi.fn();
    Object.defineProperty(
      f[key],
      key === "policy"
        ? "warningOverrideAllowed"
        : key === "context"
          ? "tenantReference"
          : "checks",
      { get, enumerable: true },
    );
    expect(f.bind).toThrow();
    expect(get).not.toHaveBeenCalled();
  }
});
