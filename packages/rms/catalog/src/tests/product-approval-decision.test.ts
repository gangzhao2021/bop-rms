import { expect, it, vi } from "vitest";
import { productPolicyScopeLevels } from "@bop/publishing";
import {
  bindCatalogProductReviewForApproval,
  createCatalogProductApprovalDecision,
  parseCatalogApprovalValiditySeconds,
} from "../contracts/product-approval-decision.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  planCatalogProductPublication,
  productPublicationCheckCodes,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
} from "../contracts/product-publication.js";
import { buildCatalogProductApprovalReceipt } from "../contracts/product-approval-receipt.js";
const id = (n: number) => "01902420-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-29T12:00:00.000Z",
  until = "2026-09-30T12:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture() {
  const command = (
    action: ProductPublicationCommand["action"],
    root: number,
    pub: number,
    actor = 3,
  ): ProductPublicationCommand => ({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(actor),
    actorKind: "User",
    operationReference: id(10 + pub),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: root,
    expectedPublicationVersion: pub,
    action,
    contentDigest: hash("content"),
    configurationDigest: hash("config"),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: "2026-09-29T13:00:00.000Z",
        localDateTime: "2026-09-29T13:00:00.000",
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
    scheduleReference: action === "SchedulePublish" ? id(40) : null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_APPROVAL",
  });
  const facts = (c: ProductPublicationCommand): ProductPublicationFacts => ({
    now: at,
    productAggregateVersion: c.expectedProductAggregateVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      evidenceReference: id(18),
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(19),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: until,
    },
    approval: null,
    reviewReference: id(20),
    replacement: null,
  });
  const first = command("Validate", 1, 0),
    v = planCatalogProductPublication(first, null, facts(first)),
    submit = command("SubmitReview", 2, 1),
    review = planCatalogProductPublication(submit, v, facts(submit)),
    c = command("Approve", 3, 2, 4),
    f = facts(c);
  const approval = {
    evidenceReference: id(21),
    reviewReference: id(20),
    reviewVersion: 2,
    requestedByActorReference: id(3),
    approvedByActorReference: id(4),
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: f.scopeDigest,
    periodDigest: f.periodDigest,
    policyReference: id(19),
    policyVersion: 1,
    approvedAt: at,
    validUntil: until,
  };
  const approved = planCatalogProductPublication(c, review, { ...f, approval }),
    receipt = buildCatalogProductApprovalReceipt(approved, approval);
  const request = {
    productReference: id(5),
    versionReference: id(6),
    expectedAggregateVersion: 4,
    expectedPublicationVersion: 3,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: f.scopeDigest,
    periodDigest: f.periodDigest,
    policyReference: id(19),
    policyVersion: 1,
    originalIntentDigest: hash("caller"),
    observedAt: at,
    validUntil: "2026-09-29T12:00:30.000Z",
  };
  return { command, facts, approval, approved, review, receipt, request };
}

function policy(observedAt: string) {
  return {
    content: {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(90),
      policyReference: id(19),
      policyVersion: 1,
      scopeOrder: productPolicyScopeLevels,
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: "2026-09-29T12:00:20.000Z",
    },
    currentPublicationReference: id(91),
    observedAt,
    validUntil: "2026-09-29T12:00:20.000Z",
  };
}
it("derives the independent decision from exact review/current policy and actual trusted time", () => {
  const f = fixture(),
    c = f.command("Approve", 3, 2, 4),
    now = "2026-09-29T12:00:01.000Z",
    r = bindCatalogProductReviewForApproval(c, f.review, now),
    d = createCatalogProductApprovalDecision(c, r, policy(now), now, 12);
  expect(d.approval).toMatchObject({
    evidenceReference: c.operationReference,
    reviewReference: id(20),
    reviewVersion: 2,
    requestedByActorReference: id(3),
    approvedByActorReference: id(4),
    approvedAt: now,
    validUntil: "2026-09-29T12:00:13.000Z",
  });
  expect(d.validUntil).toBe(d.approval.validUntil);
  expect(d.validation).toBe("NotEvaluated");
  expect(d.eligibility).toBe("NotEvaluated");
  const capped = createCatalogProductApprovalDecision(c, r, policy(now), now, 86400);
  expect(capped.approval.validUntil).toBe("2026-09-29T12:00:20.000Z");
  const open = { ...policy(now), content: { ...policy(now).content, effectiveUntil: null } };
  expect(createCatalogProductApprovalDecision(c, r, open, now, 86400).approval.validUntil).toBe(
    "2026-09-30T12:00:01.000Z",
  );
  expect(createCatalogProductApprovalDecision(c, r, open, now, 86400).validUntil).toBe(
    open.validUntil,
  );
});
it.each([0, -1, 1.5, 86401, undefined, null, "12"])(
  "requires explicit bounded server duration %s",
  (value) => {
    expect(() => parseCatalogApprovalValiditySeconds(value)).toThrow();
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "action",
  "actorKind",
  "expectedProductAggregateVersion",
  "expectedPublicationVersion",
  "contentDigest",
])("refuses a changed approval command %s", (key) => {
  const f = fixture(),
    c = f.command("Approve", 3, 2, 4);
  Object.assign(c, {
    [key]:
      key === "action"
        ? "Reject"
        : key === "actorKind"
          ? "System"
          : key.includes("Version")
            ? 9
            : key === "contentDigest"
              ? hash("different")
              : key === "actorReference"
                ? id(3)
                : id(99),
  });
  expect(() => bindCatalogProductReviewForApproval(c, f.review, at)).toThrow();
});
it("refuses stale root, canceled state, rewritten reviewer and detached review tuple", () => {
  const f = fixture(),
    c = f.command("Approve", 3, 2, 4);
  for (const patch of [
    { state: "Draft" },
    { reviewVersion: 1 },
    { submittedByActorReference: id(99) },
    { periodDigest: hash("changed") },
    { approvalPolicy: "NotRequired" },
  ])
    expect(() => bindCatalogProductReviewForApproval(c, { ...f.review, ...patch }, at)).toThrow();
});
it.each(["policyReference", "policyVersion", "approvalPolicy", "brandReference"])(
  "refuses changed current policy %s",
  (key) => {
    const f = fixture(),
      c = f.command("Approve", 3, 2, 4),
      r = bindCatalogProductReviewForApproval(c, f.review, at),
      p = policy(at);
    Object.assign(p.content, {
      [key]: key === "policyVersion" ? 2 : key === "approvalPolicy" ? "NotRequired" : id(99),
    });
    expect(() => createCatalogProductApprovalDecision(c, r, p, at, 12)).toThrow();
  },
);
it("refuses renewed review lease, wrong observation, expired current policy and future command", () => {
  const f = fixture(),
    c = f.command("Approve", 3, 2, 4),
    r = bindCatalogProductReviewForApproval(c, f.review, at),
    p = policy(at);
  expect(() =>
    createCatalogProductApprovalDecision(c, { ...r, validUntil: until }, p, at, 12),
  ).toThrow();
  expect(() =>
    createCatalogProductApprovalDecision(
      c,
      r,
      { ...p, observedAt: "2026-09-29T12:00:01.000Z" },
      at,
      12,
    ),
  ).toThrow();
  expect(() => createCatalogProductApprovalDecision(c, r, p, p.validUntil, 12)).toThrow();
  expect(() =>
    bindCatalogProductReviewForApproval({ ...c, occurredAt: until }, f.review, at),
  ).toThrow();
});
it("rejects accessors and unknown approval facts without reading them", () => {
  const f = fixture(),
    c = f.command("Approve", 3, 2, 4),
    r = bindCatalogProductReviewForApproval(c, f.review, at),
    p = policy(at),
    getter = vi.fn();
  Object.defineProperty(p.content, "approvalPolicy", { get: getter });
  expect(() => createCatalogProductApprovalDecision(c, r, p, at, 12)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    createCatalogProductApprovalDecision(c, { ...r, approval: f.approval }, policy(at), at, 12),
  ).toThrow();
});
