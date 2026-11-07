import { expect, it, vi } from "vitest";
import {
  parseDigitalReceiptTemplateLifecycleAction,
  parseDigitalReceiptTemplateLifecycleResolve,
  parseDigitalReceiptTemplateLifecycleReceipt,
} from "../contracts/digital-receipt-template-lifecycle-action.js";
import { createDigitalReceiptTemplateDraftContent } from "../contracts/digital-receipt-template-draft-fields.js";
import { materializeDigitalReceiptTemplateContent } from "../contracts/digital-receipt-template-content.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  later = "2026-10-05T10:01:00.000Z",
  until = "2026-10-05T10:02:00.000Z",
  hash = "sha256:" + "a".repeat(64);
function command() {
  return {
    profile: "DigitalReceiptTemplateLifecycleActionV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    action: "Approve",
    operationReference: id(5),
    templateReference: id(6),
    expectedVersionReference: id(7),
    expectedRevision: 2,
    reviewLifecycleReference: id(8),
    expectedReviewVersion: 2,
    expectedReviewOperationReference: id(9),
    purposeCode: "RECEIPT_TEMPLATE_REVIEW",
  };
}
function receipt() {
  const parsed = parseDigitalReceiptTemplateLifecycleAction(command());
  const { purposeCode: _purpose, ...pins } = parsed;
  void _purpose;
  return {
    ...pins,
    profile: "DigitalReceiptTemplateLifecycleReceiptV1",
    intentDigest: hash,
    outcome: "Committed",
    result: {
      lifecycleReference: id(8),
      lifecycleVersion: 3,
      state: "Approved",
      mutationOperationReference: id(5),
      changedAt: at,
      approvalEvidenceReference: id(10),
      approvedByReference: id(4),
      approvedAt: at,
      approvalValidUntil: until,
      publishedVersion: null,
    },
    auditReference: id(11),
    occurredAt: at,
  };
}
function published() {
  const base = receipt();
  const version = materializeDigitalReceiptTemplateContent({
    content: createDigitalReceiptTemplateDraftContent({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      templateReference: id(6),
      versionReference: id(7),
      versionNumber: 1,
      fields: {
        locale: "en-CA",
        layoutDefinitionReference: id(12),
        complianceRuleReference: id(13),
        activation: { mode: "Immediate" },
        effectiveUntil: null,
      },
    }),
    publicationReference: id(14),
    publishedAt: later,
  });
  return {
    ...base,
    action: "Publish",
    operationReference: id(15),
    expectedReviewVersion: 3,
    expectedReviewOperationReference: id(5),
    occurredAt: later,
    result: {
      ...base.result,
      lifecycleVersion: 4,
      state: "Published",
      mutationOperationReference: id(15),
      changedAt: later,
      publishedVersion: version,
    },
  };
}
it("parses exact 14/15/18 key protocols and detached original approval without a current-clock renewal", () => {
  const parsed = parseDigitalReceiptTemplateLifecycleAction(command());
  expect(Object.keys(parsed)).toHaveLength(14);
  expect(
    Object.keys(
      parseDigitalReceiptTemplateLifecycleResolve({
        ...command(),
        profile: "DigitalReceiptTemplateLifecycleResolveV1",
        intentDigest: hash,
      }),
    ),
  ).toHaveLength(15);
  const input = receipt(),
    saved = parseDigitalReceiptTemplateLifecycleReceipt(input);
  expect(Object.keys(saved)).toHaveLength(18);
  expect(Object.keys(saved.result ?? {})).toHaveLength(10);
  expect(saved.result?.approvalValidUntil).toBe(until);
  expect(Object.isFrozen(saved)).toBe(true);
  expect(Object.isFrozen(saved.result)).toBe(true);
  input.result.approvedByReference = id(40);
  expect(saved.result?.approvedByReference).toBe(id(4));
});
it("allows the actual approver to publish and keeps the existing 17-field envelope rather than inventing a V2 profile", () => {
  const input = published(),
    saved = parseDigitalReceiptTemplateLifecycleReceipt(input);
  expect(saved.actorReference).toBe(saved.result?.approvedByReference);
  expect(saved.result?.publishedVersion?.effectiveFrom).toBe(later);
  expect(Object.keys(saved.result?.publishedVersion ?? {})).toHaveLength(17);
  expect(Object.isFrozen(saved.result?.publishedVersion?.requiredFields)).toBe(true);
  expect(saved.result?.publishedVersion).not.toBe(input.result.publishedVersion);
});
it.each(["Approve", "Publish"])(
  "keeps Abandoned %s payload-free without asserting a review outcome",
  (action) => {
    const parsed = parseDigitalReceiptTemplateLifecycleReceipt({
      ...receipt(),
      action,
      outcome: "Abandoned",
      result: null,
    });
    expect(parsed.result).toBeNull();
    expect(() =>
      parseDigitalReceiptTemplateLifecycleReceipt({ ...receipt(), action, outcome: "Abandoned" }),
    ).toThrow(DigitalReceiptTemplateError);
  },
);
it.each([
  { action: "Cancel" },
  { expectedRevision: 0 },
  { expectedRevision: 2147483648 },
  { expectedReviewVersion: 1 },
  { expectedReviewVersion: 2147483647 },
  { operationReference: id(9) },
  { expectedVersionReference: null },
  { expectedReviewOperationReference: "bad" },
  { purposeCode: "RECEIPT_TEMPLATE_AUTHORING" },
  { validationValidUntil: until },
  { legalConclusion: "Pass" },
])("refuses malformed or injected action pins %j", (change) => {
  expect(() => parseDigitalReceiptTemplateLifecycleAction({ ...command(), ...change })).toThrow(
    DigitalReceiptTemplateError,
  );
});
it.each([
  { intentDigest: "a".repeat(64) },
  { intentDigest: "sha256:" + "A".repeat(64) },
  { fields: {} },
])("refuses malformed or payload-bearing Resolve %j", (change) => {
  expect(() =>
    parseDigitalReceiptTemplateLifecycleResolve({
      ...command(),
      profile: "DigitalReceiptTemplateLifecycleResolveV1",
      intentDigest: hash,
      ...change,
    }),
  ).toThrow(DigitalReceiptTemplateError);
});
it.each([
  { lifecycleReference: id(40) },
  { lifecycleVersion: 4 },
  { mutationOperationReference: id(40) },
  { changedAt: later },
  { approvedByReference: id(40) },
  { approvedAt: later },
  { approvalValidUntil: at },
  { approvalEvidenceReference: null },
  { state: "Published" },
  { professionallyApproved: true },
])("rejects counterfeit approval result %j", (change) => {
  const r = receipt();
  expect(() =>
    parseDigitalReceiptTemplateLifecycleReceipt({ ...r, result: { ...r.result, ...change } }),
  ).toThrow(DigitalReceiptTemplateError);
});
it.each(["brandReference", "storeReference", "templateReference", "versionReference"])(
  "rejects foreign published %s without retargeting the original",
  (field) => {
    const r = published();
    expect(() =>
      parseDigitalReceiptTemplateLifecycleReceipt({
        ...r,
        result: {
          ...r.result,
          publishedVersion: { ...r.result.publishedVersion, [field]: id(40) },
        },
      }),
    ).toThrow(DigitalReceiptTemplateError);
  },
);
it("rejects Publish after its original approval deadline and mismatched actual release time", () => {
  const r = published();
  expect(() =>
    parseDigitalReceiptTemplateLifecycleReceipt({
      ...r,
      result: { ...r.result, approvalValidUntil: later },
    }),
  ).toThrow(DigitalReceiptTemplateError);
  expect(() =>
    parseDigitalReceiptTemplateLifecycleReceipt({
      ...r,
      result: { ...r.result, publishedVersion: { ...r.result.publishedVersion, publishedAt: at } },
    }),
  ).toThrow(DigitalReceiptTemplateError);
  expect(() => parseDigitalReceiptTemplateLifecycleReceipt({ ...r, result: null })).toThrow(
    DigitalReceiptTemplateError,
  );
});
it("does not execute command or nested receipt accessors or admit an Audit/approval packet", () => {
  const getter = vi.fn(() => id(7)),
    c = command();
  Object.defineProperty(c, "expectedVersionReference", { enumerable: true, get: getter });
  expect(() => parseDigitalReceiptTemplateLifecycleAction(c)).toThrow(DigitalReceiptTemplateError);
  const r = receipt();
  Object.defineProperty(r.result, "approvedAt", { enumerable: true, get: getter });
  expect(() => parseDigitalReceiptTemplateLifecycleReceipt(r)).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
  for (const field of ["audit", "approvalEvidence", "providerResult"])
    expect(() =>
      parseDigitalReceiptTemplateLifecycleReceipt({ ...receipt(), [field]: {} }),
    ).toThrow(DigitalReceiptTemplateError);
});
