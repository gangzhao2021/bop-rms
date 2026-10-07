import { expect, it, vi } from "vitest";
import {
  parseDigitalReceiptTemplateSubmit,
  parseDigitalReceiptTemplateSubmitResolve,
  parseDigitalReceiptTemplateSubmitReceipt,
} from "../contracts/digital-receipt-template-submit.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const command = () => ({
  profile: "DigitalReceiptTemplateSubmitV1",
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
  operationReference: id(5),
  templateReference: id(6),
  expectedVersionReference: id(7),
  expectedRevision: 3,
  purposeCode: "RECEIPT_TEMPLATE_REVIEW",
});
const resolve = () => ({
  ...command(),
  profile: "DigitalReceiptTemplateSubmitResolveV1",
  intentDigest: digest,
});
const receipt = () => {
  const { purposeCode: _purpose, ...pins } = command();
  void _purpose;
  return {
    ...pins,
    profile: "DigitalReceiptTemplateSubmitReceiptV1",
    intentDigest: digest,
    outcome: "Committed",
    auditReference: id(8),
    occurredAt: at,
    submission: {
      profile: "DigitalReceiptTemplateSubmissionV1",
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      templateReference: id(6),
      familyReference: id(9),
      versionReference: id(7),
      draftRevision: 3,
      contentDigest: digest,
      authoredByReference: id(10),
      submittedByReference: id(4),
      operationReference: id(5),
      reviewLifecycleReference: id(11),
      reviewVersion: 2,
      validationEvidenceReference: id(12),
      checkedAt: at,
      validationValidUntil: "2026-10-05T10:02:00.000Z",
      submittedAt: at,
      auditReference: id(8),
      dataClassification: "Internal",
    },
  };
};
it("parses detached fixed original Submit and payload-free Resolve with actual field counts", () => {
  const raw = command(),
    saved = parseDigitalReceiptTemplateSubmit(raw),
    recovered = parseDigitalReceiptTemplateSubmitResolve(resolve());
  expect(Object.keys(saved)).toHaveLength(10);
  expect(Object.keys(recovered)).toHaveLength(11);
  expect(Object.isFrozen(saved)).toBe(true);
  raw.expectedRevision = 4;
  expect(saved.expectedRevision).toBe(3);
  expect(recovered).not.toHaveProperty("content");
  expect(recovered).not.toHaveProperty("validationValidUntil");
});
it("joins a Committed original without equating author and submitter or inventing current qualification", () => {
  const raw = receipt(),
    parsed = parseDigitalReceiptTemplateSubmitReceipt(raw);
  expect(Object.keys(parsed)).toHaveLength(14);
  expect(parsed.submission?.authoredByReference).not.toBe(parsed.actorReference);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.submission)).toBe(true);
  raw.submission.reviewVersion = 3;
  expect(parsed.submission?.reviewVersion).toBe(2);
  expect(parsed).not.toHaveProperty("approval");
  expect(parsed).not.toHaveProperty("currentState");
});
it("accepts Abandoned only with no submission, retaining original identity and timestamp", () => {
  const raw = { ...receipt(), outcome: "Abandoned", submission: null };
  expect(parseDigitalReceiptTemplateSubmitReceipt(raw).submission).toBeNull();
  expect(() =>
    parseDigitalReceiptTemplateSubmitReceipt({ ...raw, submission: receipt().submission }),
  ).toThrow(DigitalReceiptTemplateError);
  expect(() =>
    parseDigitalReceiptTemplateSubmitReceipt({ ...receipt(), submission: null }),
  ).toThrow(DigitalReceiptTemplateError);
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "operationReference",
  "templateReference",
  "versionReference",
  "submittedByReference",
  "auditReference",
] as const)("rejects foreign committed submission %s", (key) => {
  const raw = receipt();
  expect(() =>
    parseDigitalReceiptTemplateSubmitReceipt({
      ...raw,
      submission: { ...raw.submission, [key]: id(30) },
    }),
  ).toThrow(DigitalReceiptTemplateError);
});
it.each([{ draftRevision: 2 }, { submittedAt: "2026-10-05T10:00:01.000Z" }])(
  "rejects mismatched revision or original occurrence %j",
  (change) => {
    const raw = receipt();
    expect(() =>
      parseDigitalReceiptTemplateSubmitReceipt({
        ...raw,
        submission: { ...raw.submission, ...change },
      }),
    ).toThrow(DigitalReceiptTemplateError);
  },
);
it.each([
  { expectedRevision: 0 },
  { expectedRevision: -1 },
  { expectedRevision: 1.5 },
  { expectedRevision: 2147483648 },
  { templateReference: null },
  { expectedVersionReference: null },
  { actorReference: "unknown" },
  { profile: "DigitalReceiptTemplateSubmitV2" },
  { purposeCode: "RECEIPT_TEMPLATE_AUTHORING" },
  { validationValidUntil: at },
  { fields: {} },
  { content: "<html>" },
])("rejects malformed or extra Submit identity %j", (change) => {
  expect(() => parseDigitalReceiptTemplateSubmit({ ...command(), ...change })).toThrow(
    DigitalReceiptTemplateError,
  );
});
it.each([null, "a".repeat(64), "sha256:" + "A".repeat(64), digest + "0"])(
  "rejects malformed original intent digest %j",
  (intentDigest) => {
    expect(() => parseDigitalReceiptTemplateSubmitResolve({ ...resolve(), intentDigest })).toThrow(
      DigitalReceiptTemplateError,
    );
    expect(() => parseDigitalReceiptTemplateSubmitReceipt({ ...receipt(), intentDigest })).toThrow(
      DigitalReceiptTemplateError,
    );
  },
);
it("rejects incomplete, inherited, accessor and symbol identities without invoking getters", () => {
  const raw = command(),
    getter = vi.fn(() => id(6));
  const { operationReference: _op, ...missing } = raw;
  void _op;
  for (const v of [
    missing,
    Object.assign(Object.create(raw), raw),
    Object.defineProperty({ ...raw }, "templateReference", { enumerable: true, get: getter }),
    { ...raw, [Symbol("hidden")]: true },
  ])
    expect(() => parseDigitalReceiptTemplateSubmit(v)).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parseDigitalReceiptTemplateSubmitReceipt(
      Object.defineProperty(receipt(), "submission", { enumerable: true, get: getter }),
    ),
  ).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
});
it("rejects future outcomes, extra receipt claims and noncanonical original timestamps", () => {
  for (const change of [
    { outcome: "Approved" },
    { purposeCode: "RECEIPT_TEMPLATE_REVIEW" },
    { occurredAt: "2026-10-05T10:00:00Z" },
  ])
    expect(() => parseDigitalReceiptTemplateSubmitReceipt({ ...receipt(), ...change })).toThrow(
      DigitalReceiptTemplateError,
    );
});
