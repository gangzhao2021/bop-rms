import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { productPolicyScopeLevels } from "@bop/publishing";
import {
  bindCatalogProductReviewForApprovalV2,
  createCatalogProductApprovalDecisionV2,
  parseCatalogApprovalValiditySecondsV2,
  parseCatalogProductApprovalReceiptV2,
  buildCatalogProductApprovalReceiptV2,
  parseCatalogProductApprovalRequestV2,
  bindCatalogProductApprovalReceiptV2,
  bindCatalogProductApprovalToCurrentPolicyV2,
  productApprovalReviewFieldsV2,
  productApprovalSourceFieldsV2,
} from "../contracts/product-approval-v2.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
  planCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
} from "../contracts/product-publication-v2.js";
import { parseCatalogProductScopeReplacementIntent } from "../contracts/product-scope-replacement-intent.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseCatalogProductApprovalReceipt,
  parseCatalogProductApprovalRequest,
  buildCatalogProductApprovalReceipt,
} from "../contracts/product-approval-receipt.js";
import { bindCatalogProductReviewForApproval } from "../contracts/product-approval-decision.js";

const id = (n: number) => `01902441-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-02T12:00:00.000Z",
  later = "2026-10-02T13:00:00.000Z",
  until = "2026-10-03T12:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const scope = {
  level: "Store" as const,
  reference: id(70),
  channelCodes: ["WEB"],
  orderTypeCodes: ["PICKUP"],
};
const period = { timeZone: "UTC", effectiveFrom: boundary(later), effectiveUntil: null };
function intent(previous = 80) {
  const body = {
    profile: "CatalogProductExactStoreSelectorReplacementV1",
    mode: "PermanentSelectorRetirement",
    previousVersionReference: id(previous),
    previousPublicationOperationReference: id(previous + 1),
    expectedPreviousPublicationVersion: 3,
    previousIntentDigest: hash("synthetic original operation"),
    previousScopeDigest: hash([scope, { ...scope, reference: id(71) }]),
    previousPeriodDigest: hash(period),
    previousSelectorIndex: 0,
    previousSelectorDigest: hash(scope),
  };
  return parseCatalogProductScopeReplacementIntent({ ...body, digest: hash(body) });
}
function command(
  action: ProductPublicationCommandV2["action"],
  publicationVersion: number,
  actor = 3,
) {
  const replacementIntent = intent();
  return parseProductPublicationCommandV2({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(actor),
    actorKind: "User",
    operationReference: id(200 + publicationVersion),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 10 + publicationVersion,
    expectedPublicationVersion: publicationVersion,
    action,
    contentDigest: hash("synthetic content"),
    configurationDigest: hash("synthetic configuration"),
    scopeSet: [scope],
    effectivePeriod: period,
    scheduleReference: action === "SchedulePublish" ? id(40) : null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_APPROVAL",
    profile: "CatalogProductPublicationCommandV2",
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
  });
}
function facts(c: ProductPublicationCommandV2): ProductPublicationFactsV2 {
  return {
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
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          code === "ApprovalPolicy" && ["Validate", "SubmitReview"].includes(c.action)
            ? "Pending"
            : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: until,
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: c.replacementIntentDigest,
    },
    approval: null,
    reviewReference: id(20),
    replacement: null,
  };
}
function policy(observedAt = at) {
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
      effectiveUntil: "2026-10-02T12:01:00.000Z",
    },
    currentPublicationReference: id(91),
    observedAt,
    validUntil: "2026-10-02T12:00:20.000Z",
  };
}
function fixture(reviewDecision: "ApprovalPending" | "Pass" = "ApprovalPending") {
  const first = command("Validate", 0),
    draft = planCatalogProductPublicationV2(first, null, facts(first)),
    submit = command("SubmitReview", 1),
    submitted = planCatalogProductPublicationV2(submit, draft, facts(submit)),
    // Explicit synthetic historical record: new Required SubmitReview uses
    // ApprovalPending, while previously committed legal Pass remains readable.
    review =
      reviewDecision === "Pass"
        ? parseProductPublicationVersionV2({ ...submitted, validationDecision: "Pass" })
        : submitted,
    approve = command("Approve", 2, 4),
    proof = bindCatalogProductReviewForApprovalV2(approve, review, at),
    decision = createCatalogProductApprovalDecisionV2(approve, proof, policy(), at, 12),
    approved = planCatalogProductPublicationV2(approve, review, {
      ...facts(approve),
      approval: decision.approval,
    }),
    receipt = buildCatalogProductApprovalReceiptV2(approved, decision.approval),
    request = parseCatalogProductApprovalRequestV2({
      profile: "CatalogProductApprovalRequestV2",
      productReference: id(5),
      versionReference: id(6),
      expectedAggregateVersion: approved.productAggregateVersion + 1,
      expectedPublicationVersion: approved.publicationVersion,
      contentDigest: approved.contentDigest,
      configurationDigest: approved.configurationDigest,
      scopeDigest: approved.scopeDigest,
      periodDigest: approved.periodDigest,
      policyReference: approved.policyReference,
      policyVersion: approved.policyVersion,
      originalIntentDigest: hash("synthetic next caller command"),
      replacementIntentDigest: intent().digest,
      observedAt: at,
      validUntil: "2026-10-02T12:00:30.000Z",
    });
  const observation = bindCatalogProductApprovalReceiptV2(
    receipt,
    approved,
    review,
    approved,
    request,
    at,
  );
  return { draft, review, approve, proof, decision, approved, receipt, request, observation };
}
function without(value: object, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
function signed(value: object) {
  const body = without(value, ["digest"]);
  return { ...body, digest: hash(body) };
}
function retarget<T extends { replacementIntent: object; replacementIntentDigest: string }>(
  value: T,
) {
  const replacementIntent = intent(100);
  return { ...value, replacementIntent, replacementIntentDigest: replacementIntent.digest };
}

describe("explicit V2 review and current-policy decision", () => {
  it("binds the actual Pending review without projecting it to a V1 Pass", () => {
    const f = fixture(),
      bytes = canonicalizeRfc8785(f.review);
    expect(f.draft.validationDecision).toBe("ApprovalPending");
    expect(f.review.validationDecision).toBe("ApprovalPending");
    expect(f.proof.review.validationDecision).toBe("ApprovalPending");
    expect(f.proof.review.approvalEvidenceReference).toBeNull();
    expect(Object.isFrozen(f.proof)).toBe(true);
    expect(Object.isFrozen(f.proof.review)).toBe(true);
    expect(f.approved.validationDecision).toBe("Pass");
    expect(f.approved.approvalEvidenceReference).toBe(f.approve.operationReference);
    expect(f.observation.receipt).toEqual(f.receipt);
    expect(canonicalizeRfc8785(f.review)).toBe(bytes);
    expect(() =>
      bindCatalogProductReviewForApproval(
        without(f.approve, ["profile", "replacementIntent", "replacementIntentDigest"]),
        without(f.review, ["profile", "replacementIntent", "replacementIntentDigest"]),
        at,
      ),
    ).toThrow();
  });

  it("retains a legal historical Pass review and its original receipt chain", () => {
    const f = fixture("Pass");
    expect(f.review.validationDecision).toBe("Pass");
    expect(f.proof.review).toEqual(f.review);
    expect(f.receipt.approval.reviewReference).toBe(f.review.reviewReference);
    expect(f.observation.receipt.originalIntentDigest).toBe(hash(f.approve));
    expect(
      bindCatalogProductApprovalToCurrentPolicyV2(f.observation, policy(), f.request, at).receipt,
    ).toEqual(f.receipt);
  });

  it.each([
    { validationDecision: "HardError" },
    { validationDecision: "WarningAcknowledgementRequired" },
    { approvalPolicy: "NotRequired" },
    { approvalEvidenceReference: id(99) },
    { actorKind: "System" },
    { operationReference: id(202) },
    { productAggregateVersion: 10 },
    { occurredAt: "2026-10-02T12:00:00.001Z" },
  ])("refuses inconsistent Pending review and original receipt chain %#", (patch) => {
    const f = fixture(),
      changed = { ...f.review, ...patch };
    expect(() => bindCatalogProductReviewForApprovalV2(f.approve, changed, at)).toThrow();
    expect(() =>
      bindCatalogProductApprovalReceiptV2(
        f.receipt,
        f.approved,
        changed,
        f.approved,
        f.request,
        at,
      ),
    ).toThrow();
  });

  it("refuses an approval request predating the original review even when observed later", () => {
    const f = fixture();
    expect(() =>
      bindCatalogProductReviewForApprovalV2(
        { ...f.approve, occurredAt: "2026-10-02T11:59:59.999Z" },
        f.review,
        at,
      ),
    ).toThrow();
  });

  it("keeps the full command hash, deterministic independent decision and original validity bounds", () => {
    const f = fixture();
    expect(f.proof).toMatchObject({
      profile: "CatalogProductApprovalReviewV2",
      commandIntentDigest: hash(f.approve),
      replacementIntentDigest: intent().digest,
    });
    expect(f.proof.commandIntentDigest).not.toBe(
      hash(without(f.approve, ["profile", "replacementIntent", "replacementIntentDigest"])),
    );
    expect(f.decision.approval).toMatchObject({
      profile: "CatalogProductPublicationApprovalV2",
      evidenceReference: f.approve.operationReference,
      approvedByActorReference: id(4),
      requestedByActorReference: id(3),
      replacementIntentDigest: intent().digest,
      approvedAt: at,
      validUntil: "2026-10-02T12:00:12.000Z",
    });
    expect(f.decision.validUntil).toBe(f.decision.approval.validUntil);
    expect(f.decision.validation).toBe("NotEvaluated");
    expect(f.decision.eligibility).toBe("NotEvaluated");
    expect(
      createCatalogProductApprovalDecisionV2(f.approve, f.proof, policy(), at, 86400).approval
        .validUntil,
    ).toBe(policy().content.effectiveUntil);
    const open = { ...policy(), content: { ...policy().content, effectiveUntil: null } };
    const capped = createCatalogProductApprovalDecisionV2(f.approve, f.proof, open, at, 86400);
    expect(capped.approval.validUntil).toBe(until);
    expect(capped.validUntil).toBe(open.validUntil);
  });

  it("uses actual independent decision time and accepts later recorded execution without changing the command hash", () => {
    const f = fixture(),
      now = "2026-10-02T12:00:01.000Z",
      recordedAt = "2026-10-02T12:00:02.000Z",
      proof = bindCatalogProductReviewForApprovalV2(f.approve, f.review, now),
      decision = createCatalogProductApprovalDecisionV2(f.approve, proof, policy(now), now, 12),
      approved = parseProductPublicationVersionV2({ ...f.approved, occurredAt: recordedAt }),
      receipt = buildCatalogProductApprovalReceiptV2(approved, decision.approval);
    expect(receipt.recordedAt).toBe(recordedAt);
    expect(receipt.approval.approvedAt).toBe(now);
    expect(receipt.originalIntentDigest).toBe(hash(f.approve));
    expect(() => buildCatalogProductApprovalReceiptV2(f.approved, decision.approval)).toThrow();
  });

  it.each([0, -1, 1.5, 86401, null, undefined, "12"])(
    "refuses invalid server validity %s",
    (value) => {
      expect(() => parseCatalogApprovalValiditySecondsV2(value)).toThrow();
    },
  );

  it.each([
    { tenantReference: id(99) },
    { brandReference: id(99) },
    { actorReference: id(3) },
    { action: "Reject" },
    { actorKind: "System" },
    { expectedProductAggregateVersion: 99 },
    { expectedPublicationVersion: 99 },
    { contentDigest: hash("changed") },
    { occurredAt: until },
  ])("refuses altered approval command %#", (patch) => {
    const f = fixture();
    expect(() =>
      bindCatalogProductReviewForApprovalV2({ ...f.approve, ...patch }, f.review, at),
    ).toThrow();
  });

  it("rejects a retargeted command/review and a rewritten review proof or V1 command hash", () => {
    const f = fixture();
    expect(() =>
      bindCatalogProductReviewForApprovalV2(retarget(f.approve), f.review, at),
    ).toThrow();
    expect(() =>
      bindCatalogProductReviewForApprovalV2(f.approve, retarget(f.review), at),
    ).toThrow();
    for (const patch of [
      { replacementIntentDigest: intent(100).digest },
      { review: retarget(f.review) },
      {
        commandIntentDigest: hash(
          without(f.approve, ["profile", "replacementIntent", "replacementIntentDigest"]),
        ),
      },
      { validUntil: until },
      { observedAggregateVersion: 99 },
      { profile: "CatalogProductApprovalReviewV1" },
    ])
      expect(() =>
        createCatalogProductApprovalDecisionV2(
          f.approve,
          { ...f.proof, ...patch },
          policy(),
          at,
          12,
        ),
      ).toThrow();
  });

  it.each([
    "tenantReference",
    "brandReference",
    "policyReference",
    "policyVersion",
    "approvalPolicy",
  ])("refuses changed current policy %s", (key) => {
    const f = fixture(),
      p = policy(),
      value = key === "policyVersion" ? 2 : key === "approvalPolicy" ? "NotRequired" : id(99);
    expect(() =>
      createCatalogProductApprovalDecisionV2(
        f.approve,
        f.proof,
        { ...p, content: { ...p.content, [key]: value } },
        at,
        12,
      ),
    ).toThrow();
    expect(() =>
      bindCatalogProductApprovalToCurrentPolicyV2(
        f.observation,
        { ...p, content: { ...p.content, [key]: value } },
        f.request,
        at,
      ),
    ).toThrow();
  });
});

describe("V2 immutable receipt and original provenance", () => {
  it("binds the original independent Approve receipt through Approved and Scheduled heads", () => {
    const f = fixture();
    expect(f.receipt).toMatchObject({
      profile: "CatalogProductApprovalReceiptV2",
      originalIntentDigest: hash(f.approve),
      replacementIntentDigest: intent().digest,
    });
    expect(f.observation.receipt).toEqual(f.receipt);
    expect(f.observation.validUntil).toBe(f.decision.approval.validUntil);
    expect(f.observation.currentPolicy).toBe("NotEvaluated");
    const c = command("SchedulePublish", 3),
      scheduled = planCatalogProductPublicationV2(c, f.approved, {
        ...facts(c),
        approval: f.decision.approval,
      }),
      request = { ...f.request, expectedAggregateVersion: 14, expectedPublicationVersion: 4 };
    const bound = bindCatalogProductApprovalReceiptV2(
      f.receipt,
      f.approved,
      f.review,
      scheduled,
      request,
      at,
    );
    expect(bound.receipt).toEqual(f.receipt);
    expect(bound.validUntil).toBe(f.observation.validUntil);
    expect(bound.replacementIntentDigest).toBe(intent().digest);
  });

  it("does not authorize a changed-period Required reschedule from the old receipt", () => {
    const f = fixture(),
      c = command("SchedulePublish", 3),
      scheduled = planCatalogProductPublicationV2(c, f.approved, {
        ...facts(c),
        approval: f.decision.approval,
      }),
      changedPeriod = { ...period, effectiveFrom: boundary("2026-10-02T14:00:00.000Z") },
      changed = parseProductPublicationVersionV2({
        ...scheduled,
        effectivePeriod: changedPeriod,
        periodDigest: hash(changedPeriod),
      }),
      request = {
        ...f.request,
        expectedAggregateVersion: 14,
        expectedPublicationVersion: 4,
        periodDigest: hash(changedPeriod),
      };
    expect(() =>
      bindCatalogProductApprovalReceiptV2(f.receipt, f.approved, f.review, changed, request, at),
    ).toThrow();
    expect(() =>
      buildCatalogProductApprovalReceiptV2(changed, {
        ...f.decision.approval,
        periodDigest: hash(changedPeriod),
      }),
    ).toThrow();
  });

  it("rejects target changes at every receipt-binding input", () => {
    const f = fixture(),
      changedReceipt = signed({
        ...f.receipt,
        replacementIntentDigest: intent(100).digest,
        approval: { ...f.receipt.approval, replacementIntentDigest: intent(100).digest },
      });
    for (const [receipt, approved, review, current, request] of [
      [changedReceipt, f.approved, f.review, f.approved, f.request],
      [f.receipt, retarget(f.approved), f.review, f.approved, f.request],
      [f.receipt, f.approved, retarget(f.review), f.approved, f.request],
      [f.receipt, f.approved, f.review, retarget(f.approved), f.request],
      [
        f.receipt,
        f.approved,
        f.review,
        f.approved,
        { ...f.request, replacementIntentDigest: intent(100).digest },
      ],
    ])
      expect(() =>
        bindCatalogProductApprovalReceiptV2(receipt, approved, review, current, request, at),
      ).toThrow();
  });

  it.each([
    { approvalOperationReference: id(99) },
    { approvalPublicationVersion: 9 },
    { recordedAt: "2026-10-02T11:59:59.999Z" },
    { recordedAt: "2026-10-02T12:00:12.000Z" },
    { replacementIntentDigest: hash("wrong") },
  ])("refuses malformed original receipt provenance %#", (patch) => {
    expect(() =>
      parseCatalogProductApprovalReceiptV2(signed({ ...fixture().receipt, ...patch })),
    ).toThrow();
  });

  it.each([
    "contentDigest",
    "configurationDigest",
    "scopeDigest",
    "periodDigest",
    "policyReference",
    "policyVersion",
  ])("cannot renew approval for changed %s", (key) => {
    const f = fixture(),
      value = key === "policyVersion" ? 2 : key === "policyReference" ? id(99) : hash("changed");
    expect(() =>
      bindCatalogProductApprovalReceiptV2(
        f.receipt,
        f.approved,
        f.review,
        f.approved,
        { ...f.request, [key]: value },
        at,
      ),
    ).toThrow();
  });

  it("rejects stale roots, changed history, expiry and a self-approved record", () => {
    const f = fixture();
    expect(() =>
      bindCatalogProductApprovalReceiptV2(
        f.receipt,
        f.approved,
        f.review,
        f.approved,
        { ...f.request, expectedAggregateVersion: 99 },
        at,
      ),
    ).toThrow();
    expect(() =>
      bindCatalogProductApprovalReceiptV2(
        f.receipt,
        f.approved,
        { ...f.review, actorReference: id(99) },
        f.approved,
        f.request,
        at,
      ),
    ).toThrow();
    expect(() =>
      bindCatalogProductApprovalReceiptV2(
        f.receipt,
        f.approved,
        f.review,
        f.approved,
        f.request,
        f.decision.approval.validUntil,
      ),
    ).toThrow();
    expect(() =>
      buildCatalogProductApprovalReceiptV2(f.approved, {
        ...f.decision.approval,
        approvedByActorReference: id(3),
      }),
    ).toThrow();
    expect(() =>
      buildCatalogProductApprovalReceiptV2(f.approved, {
        ...f.decision.approval,
        replacementIntentDigest: intent(100).digest,
      }),
    ).toThrow();
  });
});

describe("V2 current-policy observations and closed boundaries", () => {
  it("retains original approval and policy expiry without manufacturing validation or eligibility", () => {
    const f = fixture(),
      shorter = { ...policy(), validUntil: "2026-10-02T12:00:05.000Z" },
      bound = bindCatalogProductApprovalToCurrentPolicyV2(f.observation, shorter, f.request, at);
    expect(bound).toMatchObject({
      profile: "CatalogProductApprovalPolicyObservationV2",
      replacementIntentDigest: intent().digest,
      receipt: f.receipt,
      validUntil: shorter.validUntil,
      validation: "NotEvaluated",
      eligibility: "NotEvaluated",
    });
    expect(bound.currentPolicy).toMatchObject({
      policyReference: id(19),
      policyVersion: 1,
      publicationReference: id(91),
      approvalPolicy: "Required",
    });
    expect(
      bindCatalogProductApprovalToCurrentPolicyV2(f.observation, policy(), f.request, at)
        .validUntil,
    ).toBe(f.decision.approval.validUntil);
  });

  it("refuses target, observation, original command and lease substitutions", () => {
    const f = fixture();
    for (const patch of [
      { replacementIntentDigest: intent(100).digest },
      { observedAggregateVersion: 99 },
      { currentPublicationVersion: 99 },
      { observationIntentDigest: hash("changed") },
      { validUntil: f.request.validUntil },
      { observedAt: "2026-10-02T12:00:01.000Z" },
    ])
      expect(() =>
        bindCatalogProductApprovalToCurrentPolicyV2(
          { ...f.observation, ...patch },
          policy(),
          f.request,
          at,
        ),
      ).toThrow();
    expect(() =>
      bindCatalogProductApprovalToCurrentPolicyV2(
        f.observation,
        policy(),
        { ...f.request, replacementIntentDigest: intent(100).digest },
        at,
      ),
    ).toThrow();
    for (const now of [
      "2026-10-02T11:59:59.999Z",
      f.decision.approval.validUntil,
      policy().validUntil,
    ])
      expect(() =>
        bindCatalogProductApprovalToCurrentPolicyV2(f.observation, policy(), f.request, now),
      ).toThrow();
    expect(() =>
      createCatalogProductApprovalDecisionV2(f.approve, f.proof, policy(), policy().validUntil, 12),
    ).toThrow();
    expect(() =>
      bindCatalogProductApprovalToCurrentPolicyV2(
        f.observation,
        { ...policy(), observedAt: later },
        f.request,
        at,
      ),
    ).toThrow();
    expect(() =>
      bindCatalogProductApprovalToCurrentPolicyV2(
        f.observation,
        { ...policy(), validUntil: until },
        f.request,
        at,
      ),
    ).toThrow();
  });

  it("requires exact V2 profiles and refuses V1 or mixed nested contracts", () => {
    const f = fixture();
    for (const [parse, value] of [
      [parseCatalogProductApprovalReceiptV2, f.receipt],
      [parseCatalogProductApprovalRequestV2, f.request],
    ] as const) {
      for (const profile of [undefined, null, "CatalogProductApprovalReceiptV1"])
        expect(() => parse({ ...value, profile })).toThrow();
      for (const field of Object.keys(value))
        expect(() => parse(without(value, [field]))).toThrow();
      expect(() => parse({ ...value, granted: true })).toThrow();
    }
    expect(() =>
      parseCatalogProductApprovalReceiptV2(
        signed({
          ...f.receipt,
          approval: without(f.receipt.approval, ["profile", "replacementIntentDigest"]),
        }),
      ),
    ).toThrow();
    expect(() =>
      parseCatalogProductApprovalReceiptV2({ ...f.receipt, digest: hash("changed") }),
    ).toThrow();
    expect(() =>
      parseCatalogProductApprovalRequestV2({ ...f.request, validUntil: until }),
    ).toThrow();
    expect(() =>
      createCatalogProductApprovalDecisionV2(
        f.approve,
        { ...f.proof, granted: true },
        policy(),
        at,
        12,
      ),
    ).toThrow();
    expect(() =>
      bindCatalogProductApprovalToCurrentPolicyV2(
        { ...f.observation, granted: true },
        policy(),
        f.request,
        at,
      ),
    ).toThrow();
  });

  it("captures detached frozen records and refuses nested accessors without evaluating them", () => {
    const f = fixture(),
      raw = { ...f.receipt, approval: { ...f.receipt.approval } },
      parsed = parseCatalogProductApprovalReceiptV2(raw),
      getter = vi.fn(() => intent().digest);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.approval)).toBe(true);
    raw.approval.replacementIntentDigest = intent(100).digest;
    expect(parsed.approval.replacementIntentDigest).toBe(intent().digest);
    const nested = Object.defineProperty({ ...f.receipt.approval }, "replacementIntentDigest", {
      enumerable: true,
      get: getter,
    });
    expect(() =>
      parseCatalogProductApprovalReceiptV2({ ...f.receipt, approval: nested }),
    ).toThrow();
    const source = policy();
    Object.defineProperty(source.content, "approvalPolicy", { enumerable: true, get: getter });
    expect(() =>
      createCatalogProductApprovalDecisionV2(f.approve, f.proof, source, at, 12),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
    for (const malformed of [
      Object.assign(Object.create(null), f.request),
      { ...f.request, [Symbol("extra")]: true },
      Object.defineProperty({ ...f.request }, "extra", { value: true, enumerable: false }),
    ])
      expect(() => parseCatalogProductApprovalRequestV2(malformed)).toThrow();
  });

  it("keeps V1 entry points closed and V1 canonical objects unchanged", () => {
    const f = fixture("Pass"),
      plain = (value: object) =>
        without(value, ["profile", "replacementIntent", "replacementIntentDigest"]),
      c = plain(f.approve),
      review = plain(f.review),
      approved = plain(f.approved),
      approval = plain(f.decision.approval),
      v1Review = bindCatalogProductReviewForApproval(c, review, at),
      v1Receipt = buildCatalogProductApprovalReceipt(approved, approval),
      bytes = canonicalizeRfc8785({ c, review, approved, approval, v1Review, v1Receipt });
    expect(() => parseCatalogProductApprovalReceipt(f.receipt)).toThrow();
    expect(() => parseCatalogProductApprovalRequest(f.request)).toThrow();
    expect(() => bindCatalogProductReviewForApproval(f.approve, f.review, at)).toThrow();
    expect(() => parseCatalogProductApprovalReceiptV2(v1Receipt)).toThrow();
    expect(() => bindCatalogProductReviewForApprovalV2(c, review, at)).toThrow();
    expect(() =>
      createCatalogProductApprovalDecisionV2(f.approve, v1Review, policy(), at, 12),
    ).toThrow();
    expect(canonicalizeRfc8785({ c, review, approved, approval, v1Review, v1Receipt })).toBe(bytes);
    expect(productApprovalReviewFieldsV2).toContain("replacementIntentDigest");
    expect(productApprovalSourceFieldsV2).toContain("replacementIntent");
    expect(Object.isFrozen(productApprovalReviewFieldsV2)).toBe(true);
    expect(Object.isFrozen(productApprovalSourceFieldsV2)).toBe(true);
  });
});
