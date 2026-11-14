import { expect, it, vi } from "vitest";
import { parseDigitalReceiptTemplateReviewCurrent } from "../contracts/digital-receipt-template-review.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  observed = "2026-10-05T10:02:00.000Z",
  until = "2026-10-05T10:02:05.000Z",
  hash = "sha256:" + "a".repeat(64);
function packet() {
  return {
    profile: "DigitalReceiptTemplateReviewCurrentV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    templateReference: id(5),
    currentDraft: { versionReference: id(6), revision: 1, contentDigest: hash },
    submission: {
      profile: "DigitalReceiptTemplateSubmissionV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      templateReference: id(5),
      familyReference: id(7),
      versionReference: id(6),
      draftRevision: 1,
      contentDigest: hash,
      authoredByReference: id(8),
      submittedByReference: id(9),
      operationReference: id(10),
      reviewLifecycleReference: id(11),
      reviewVersion: 2,
      validationEvidenceReference: id(12),
      checkedAt: at,
      validationValidUntil: "2026-10-05T10:01:00.000Z",
      submittedAt: at,
      auditReference: id(13),
      dataClassification: "Internal",
    },
    lifecycle: {
      lifecycleReference: id(11),
      version: 2,
      state: "InReview",
      latestMutationOperationReference: id(10),
      changedAt: at,
      validationEvidenceReference: id(12),
      approvalEvidenceReference: null as string | null,
    },
    observedAt: observed,
    validUntil: until,
    sourceQualification: "NotEvaluated",
  };
}
it("observes expired original review history with a different current reader, without renewing its business deadline", () => {
  const input = packet(),
    parsed = parseDigitalReceiptTemplateReviewCurrent(input);
  expect(Object.keys(parsed)).toHaveLength(12);
  expect(parsed.submission?.validationValidUntil).toBe("2026-10-05T10:01:00.000Z");
  expect(parsed.actorReference).not.toBe(parsed.submission?.submittedByReference);
  expect(parsed.sourceQualification).toBe("NotEvaluated");
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.currentDraft)).toBe(true);
  expect(Object.isFrozen(parsed.submission)).toBe(true);
  expect(Object.isFrozen(parsed.lifecycle)).toBe(true);
  input.currentDraft.contentDigest = "sha256:" + "b".repeat(64);
  input.submission.submittedByReference = id(40);
  expect(parsed.currentDraft.contentDigest).toBe(hash);
  expect(parsed.submission?.submittedByReference).toBe(id(9));
});
it("returns truthful absent review only when both original submission and lifecycle are absent", () => {
  expect(
    parseDigitalReceiptTemplateReviewCurrent({ ...packet(), submission: null, lifecycle: null })
      .lifecycle,
  ).toBeNull();
  expect(() => parseDigitalReceiptTemplateReviewCurrent({ ...packet(), submission: null })).toThrow(
    DigitalReceiptTemplateError,
  );
  expect(() => parseDigitalReceiptTemplateReviewCurrent({ ...packet(), lifecycle: null })).toThrow(
    DigitalReceiptTemplateError,
  );
  expect(() =>
    parseDigitalReceiptTemplateReviewCurrent({ ...packet(), currentDraft: null }),
  ).toThrow(DigitalReceiptTemplateError);
});
it.each(["Approved", "Published", "Archived"])(
  "preserves actual %s current head while a newer Draft differs from its submitted snapshot",
  (state) => {
    const value = packet();
    const parsed = parseDigitalReceiptTemplateReviewCurrent({
      ...value,
      currentDraft: {
        versionReference: id(20),
        revision: 2,
        contentDigest: "sha256:" + "b".repeat(64),
      },
      lifecycle: {
        ...value.lifecycle,
        state,
        version: 3,
        latestMutationOperationReference: id(21),
        changedAt: observed,
        approvalEvidenceReference: id(22),
      },
    });
    expect(parsed.currentDraft.versionReference).not.toBe(parsed.submission?.versionReference);
    expect(parsed.lifecycle?.state).toBe(state);
  },
);
it.each([
  ["wrong Tenant", (p: ReturnType<typeof packet>) => ({ ...p, tenantReference: id(30) })],
  ["wrong Brand", (p: ReturnType<typeof packet>) => ({ ...p, brandReference: id(30) })],
  ["wrong Store", (p: ReturnType<typeof packet>) => ({ ...p, storeReference: id(30) })],
  ["wrong Template", (p: ReturnType<typeof packet>) => ({ ...p, templateReference: id(30) })],
  [
    "wrong lifecycle",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      lifecycle: { ...p.lifecycle, lifecycleReference: id(30) },
    }),
  ],
  [
    "wrong validation",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      lifecycle: { ...p.lifecycle, validationEvidenceReference: id(30) },
    }),
  ],
  [
    "wrong original operation",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      lifecycle: { ...p.lifecycle, latestMutationOperationReference: id(30) },
    }),
  ],
  [
    "lower lifecycle version",
    (p: ReturnType<typeof packet>) => ({ ...p, lifecycle: { ...p.lifecycle, version: 1 } }),
  ],
  [
    "unsupported Draft state",
    (p: ReturnType<typeof packet>) => ({ ...p, lifecycle: { ...p.lifecycle, state: "Draft" } }),
  ],
  [
    "head before submission",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      lifecycle: { ...p.lifecycle, changedAt: "2026-10-05T09:59:59.999Z" },
    }),
  ],
  [
    "head after observation",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      lifecycle: { ...p.lifecycle, changedAt: "2026-10-05T10:02:00.001Z" },
    }),
  ],
  [
    "forged same-version digest",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      currentDraft: { ...p.currentDraft, contentDigest: "sha256:" + "b".repeat(64) },
    }),
  ],
  [
    "different version at same revision",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      currentDraft: { ...p.currentDraft, versionReference: id(30) },
    }),
  ],
  [
    "missing digest prefix",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      currentDraft: { ...p.currentDraft, contentDigest: "a".repeat(64) },
    }),
  ],
  [
    "overlong source lease",
    (p: ReturnType<typeof packet>) => ({ ...p, validUntil: "2026-10-05T10:02:05.001Z" }),
  ],
  ["expired source lease", (p: ReturnType<typeof packet>) => ({ ...p, validUntil: observed })],
  [
    "noncanonical instant",
    (p: ReturnType<typeof packet>) => ({ ...p, observedAt: "2026-10-05T10:02:00Z" }),
  ],
  ["fake qualification", (p: ReturnType<typeof packet>) => ({ ...p, sourceQualification: "Pass" })],
  [
    "extra current Draft field",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      currentDraft: { ...p.currentDraft, approved: true },
    }),
  ],
  [
    "extra scope on public head",
    (p: ReturnType<typeof packet>) => ({
      ...p,
      lifecycle: { ...p.lifecycle, familyReference: id(7) },
    }),
  ],
])("rejects %s", (_name, change) => {
  expect(() => parseDigitalReceiptTemplateReviewCurrent(change(packet()))).toThrow(
    DigitalReceiptTemplateError,
  );
});
it("rejects accessors and unknown approval, legal, or private mutation packets without invoking them", () => {
  const getter = vi.fn(() => packet().lifecycle);
  const input = packet();
  Object.defineProperty(input, "lifecycle", { enumerable: true, get: getter });
  expect(() => parseDigitalReceiptTemplateReviewCurrent(input)).toThrow(
    DigitalReceiptTemplateError,
  );
  expect(getter).not.toHaveBeenCalled();
  for (const field of ["mutation", "audit", "legalConclusion", "approvalDecision", "providerReady"])
    expect(() => parseDigitalReceiptTemplateReviewCurrent({ ...packet(), [field]: true })).toThrow(
      DigitalReceiptTemplateError,
    );
});
it("rejects nested accessors without executing a source or inferring an approval", () => {
  const p = packet(),
    getter = vi.fn(() => id(6));
  Object.defineProperty(p.currentDraft, "versionReference", { enumerable: true, get: getter });
  expect(() => parseDigitalReceiptTemplateReviewCurrent(p)).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parseDigitalReceiptTemplateReviewCurrent({
      ...packet(),
      lifecycle: { ...packet().lifecycle, approvalEvidenceReference: id(20) },
    }),
  ).toThrow(DigitalReceiptTemplateError);
});
