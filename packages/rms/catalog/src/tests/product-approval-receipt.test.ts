import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  planCatalogProductPublication,
  productPublicationCheckCodes,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
} from "../contracts/product-publication.js";
import {
  buildCatalogProductApprovalReceipt,
  parseCatalogProductApprovalReceipt,
  parseCatalogProductApprovalRequest,
  bindCatalogProductApprovalReceipt,
} from "../contracts/product-approval-receipt.js";
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
describe("owning Product approval receipt", () => {
  it("preserves exact original approval expiry, review and independent signer", () => {
    const f = fixture(),
      proof = bindCatalogProductApprovalReceipt(
        f.receipt,
        f.approved,
        f.review,
        f.approved,
        f.request,
        at,
      );
    expect(proof.receipt.approval).toEqual(f.approval);
    expect(proof.validUntil).toBe(f.request.validUntil);
    expect(proof).toMatchObject({ currentPolicy: "NotEvaluated", eligibility: "NotEvaluated" });
    expect(proof).toMatchObject({
      observedAggregateVersion: 4,
      currentPublicationVersion: 3,
      observationIntentDigest: f.request.originalIntentDigest,
    });
    expect(parseCatalogProductApprovalReceipt(f.receipt)).toEqual(f.receipt);
  });
  it("retains original expiry when it is earlier than the observation", () => {
    const f = fixture(),
      approval = { ...f.approval, validUntil: "2026-09-29T12:00:10.000Z" },
      r = buildCatalogProductApprovalReceipt(f.approved, approval);
    expect(
      bindCatalogProductApprovalReceipt(r, f.approved, f.review, f.approved, f.request, at)
        .validUntil,
    ).toBe(approval.validUntil);
  });
  it("reads a subsequent Scheduled head without inventing new approval validity", () => {
    const f = fixture(),
      c = f.command("SchedulePublish", 4, 3),
      scheduled = planCatalogProductPublication(c, f.approved, {
        ...f.facts(c),
        approval: f.approval,
      });
    const proof = bindCatalogProductApprovalReceipt(
      f.receipt,
      f.approved,
      f.review,
      scheduled,
      { ...f.request, expectedAggregateVersion: 5, expectedPublicationVersion: 4 },
      at,
    );
    expect(proof.receipt.approvalOperationReference).toBe(f.approved.operationReference);
    expect(proof).toMatchObject({ observedAggregateVersion: 5, currentPublicationVersion: 4 });
  });
  for (const field of [
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "policyReference",
    "policyVersion",
    "productReference",
    "versionReference",
    "expectedAggregateVersion",
    "expectedPublicationVersion",
  ] as const) {
    it("refuses a different current " + field, () => {
      const f = fixture(),
        v =
          field.startsWith("expected") || field === "policyVersion"
            ? 99
            : field.endsWith("Digest")
              ? hash("other")
              : id(99);
      expect(() =>
        bindCatalogProductApprovalReceipt(
          f.receipt,
          f.approved,
          f.review,
          f.approved,
          { ...f.request, [field]: v },
          at,
        ),
      ).toThrow();
    });
  }
  it("does not turn a canceled review into current approval", () => {
    const f = fixture();
    expect(() =>
      bindCatalogProductApprovalReceipt(
        f.receipt,
        f.approved,
        f.review,
        {
          ...f.approved,
          state: "Draft",
          reviewReference: null,
          reviewVersion: null,
          submittedByActorReference: null,
          approvalEvidenceReference: null,
        },
        f.request,
        at,
      ),
    ).toThrow();
  });
  it("refuses stale observation and original approval expiry", () => {
    const f = fixture();
    expect(() =>
      bindCatalogProductApprovalReceipt(
        f.receipt,
        f.approved,
        f.review,
        f.approved,
        f.request,
        f.request.validUntil,
      ),
    ).toThrow();
    const approval = { ...f.approval, validUntil: "2026-09-29T12:00:01.000Z" },
      r = buildCatalogProductApprovalReceipt(f.approved, approval);
    expect(() =>
      bindCatalogProductApprovalReceipt(
        r,
        f.approved,
        f.review,
        f.approved,
        f.request,
        "2026-09-29T12:00:02.000Z",
      ),
    ).toThrow();
  });
  it("refuses wrong signer, different requester and mutated receipt digest", () => {
    const f = fixture();
    expect(() =>
      buildCatalogProductApprovalReceipt(f.approved, {
        ...f.approval,
        approvedByActorReference: id(3),
      }),
    ).toThrow();
    expect(() =>
      buildCatalogProductApprovalReceipt(f.approved, {
        ...f.approval,
        requestedByActorReference: id(99),
      }),
    ).toThrow();
    expect(() =>
      parseCatalogProductApprovalReceipt({ ...f.receipt, recordedAt: "2026-09-29T12:00:00.001Z" }),
    ).toThrow();
  });
  it("does not invoke an accessor or accept unknown fields/overlong observation", () => {
    const f = fixture();
    let calls = 0;
    const v = { ...f.request };
    Object.defineProperty(v, "policyReference", {
      enumerable: true,
      get() {
        calls++;
        return id(19);
      },
    });
    expect(() => parseCatalogProductApprovalRequest(v)).toThrow();
    expect(calls).toBe(0);
    expect(() => parseCatalogProductApprovalRequest({ ...f.request, permission: true })).toThrow();
    expect(() =>
      parseCatalogProductApprovalRequest({ ...f.request, validUntil: "2026-09-29T12:00:30.001Z" }),
    ).toThrow();
  });
});
