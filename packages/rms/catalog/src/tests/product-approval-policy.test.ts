import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { productPolicyScopeLevels } from "@bop/publishing";
import { bindCatalogProductApprovalToCurrentPolicy } from "../contracts/product-approval-policy.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T08:00:00.000Z",
  until = "2026-09-30T08:00:20.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const a = {
    evidenceReference: id(21),
    reviewReference: id(20),
    reviewVersion: 2,
    requestedByActorReference: id(3),
    approvedByActorReference: id(4),
    contentDigest: hash("body"),
    configurationDigest: hash("config"),
    scopeDigest: hash("scope"),
    periodDigest: hash("period"),
    policyReference: id(19),
    policyVersion: 1,
    approvedAt: at,
    validUntil: until,
  };
  const body = {
    profile: "CatalogProductApprovalReceiptV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    versionReference: id(6),
    approvalOperationReference: id(22),
    originalIntentDigest: hash("approve"),
    approvalPublicationVersion: 3,
    resultAggregateVersion: 4,
    recordedAt: at,
    approval: a,
  };
  const request = {
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 4,
    expectedPublicationVersion: 3,
    contentDigest: a.contentDigest,
    configurationDigest: a.configurationDigest,
    scopeDigest: a.scopeDigest,
    periodDigest: a.periodDigest,
    policyReference: id(19),
    policyVersion: 1,
    originalIntentDigest: hash("caller"),
    observedAt: at,
    validUntil: "2026-09-30T08:00:30.000Z",
  };
  const approval = {
    receipt: { ...body, digest: hash(body) },
    observedAggregateVersion: 4,
    currentPublicationVersion: 3,
    observationIntentDigest: request.originalIntentDigest,
    observedAt: at,
    validUntil: until,
    currentPolicy: "NotEvaluated",
    eligibility: "NotEvaluated",
  };
  const policy = {
    content: {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(18),
      policyReference: id(19),
      policyVersion: 1,
      scopeOrder: productPolicyScopeLevels,
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: "2026-09-30T08:00:15.000Z",
    },
    currentPublicationReference: id(23),
    observedAt: at,
    validUntil: "2026-09-30T08:00:15.000Z",
  };
  return { approval, policy, request };
}
it("binds only the exact current Required policy and keeps both original validity bounds", () => {
  const f = fixture(),
    p = bindCatalogProductApprovalToCurrentPolicy(f.approval, f.policy, f.request, at);
  expect(p.validUntil).toBe(f.policy.validUntil);
  expect(p.currentPolicy).toMatchObject({
    policyReference: id(19),
    policyVersion: 1,
    publicationReference: id(23),
    approvalPolicy: "Required",
  });
  expect(p.receipt).toEqual(f.approval.receipt);
  expect(p.validation).toBe("NotEvaluated");
  expect(p.eligibility).toBe("NotEvaluated");
  const policy = {
    ...f.policy,
    content: { ...f.policy.content, effectiveUntil: null },
    validUntil: f.request.validUntil,
  };
  expect(
    bindCatalogProductApprovalToCurrentPolicy(f.approval, policy, f.request, at).validUntil,
  ).toBe(until);
});
it.each([
  "tenantReference",
  "brandReference",
  "policyReference",
  "policyVersion",
  "approvalPolicy",
])("refuses changed current policy %s", (key) => {
  const f = fixture();
  Object.assign(f.policy.content, {
    [key]: key === "policyVersion" ? 2 : key === "approvalPolicy" ? "NotRequired" : id(99),
  });
  expect(() =>
    bindCatalogProductApprovalToCurrentPolicy(f.approval, f.policy, f.request, at),
  ).toThrow();
});
it.each([
  "observedAggregateVersion",
  "currentPublicationVersion",
  "observationIntentDigest",
  "observedAt",
])("refuses changed owning observation %s", (key) => {
  const f = fixture();
  Object.assign(f.approval, {
    [key]: key.includes("Version") ? 9 : key === "observedAt" ? until : hash("other"),
  });
  expect(() =>
    bindCatalogProductApprovalToCurrentPolicy(f.approval, f.policy, f.request, at),
  ).toThrow();
});
it("refuses policy expiry, future observation and renewal beyond actual policy effective period", () => {
  const f = fixture();
  for (const now of [f.policy.validUntil, "2026-09-30T07:59:59.999Z"])
    expect(() =>
      bindCatalogProductApprovalToCurrentPolicy(f.approval, f.policy, f.request, now),
    ).toThrow();
  expect(() =>
    bindCatalogProductApprovalToCurrentPolicy(
      f.approval,
      { ...f.policy, validUntil: until },
      f.request,
      at,
    ),
  ).toThrow();
  expect(() =>
    bindCatalogProductApprovalToCurrentPolicy(
      f.approval,
      { ...f.policy, observedAt: until },
      f.request,
      at,
    ),
  ).toThrow();
});
it("refuses renamed intent or content and any renewed approval lease", () => {
  const f = fixture();
  for (const key of [
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "originalIntentDigest",
  ])
    expect(() =>
      bindCatalogProductApprovalToCurrentPolicy(
        f.approval,
        f.policy,
        { ...f.request, [key]: hash("changed") },
        at,
      ),
    ).toThrow();
  expect(() =>
    bindCatalogProductApprovalToCurrentPolicy(
      { ...f.approval, validUntil: f.request.validUntil },
      f.policy,
      f.request,
      at,
    ),
  ).toThrow();
});
it("copies closed observations without invoking accessors or accepting unknown fields", () => {
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.policy.content, "approvalPolicy", { get: getter });
  expect(() =>
    bindCatalogProductApprovalToCurrentPolicy(f.approval, f.policy, f.request, at),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    bindCatalogProductApprovalToCurrentPolicy(
      { ...f.approval, granted: true },
      fixture().policy,
      f.request,
      at,
    ),
  ).toThrow();
});
