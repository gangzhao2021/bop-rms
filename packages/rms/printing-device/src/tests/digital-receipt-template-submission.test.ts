import { expect, it, vi } from "vitest";
import {
  parseDigitalReceiptTemplateSubmission,
  createDigitalReceiptTemplateAuthoredContent,
} from "../contracts/digital-receipt-template-submission.js";
import { createDigitalReceiptTemplateDraftContent } from "../contracts/digital-receipt-template-draft-fields.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  submitted = "2026-10-05T10:01:00.000Z",
  until = "2026-10-05T10:02:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const draft = () => ({
  profile: "DigitalReceiptTemplateDraftV2",
  ...scope,
  familyReference: id(4),
  revision: 1,
  authoredByReference: id(5),
  previousVersionReference: null,
  content: createDigitalReceiptTemplateDraftContent({
    ...scope,
    templateReference: id(6),
    versionReference: id(7),
    versionNumber: 1,
    fields: {
      locale: "en-CA",
      layoutDefinitionReference: id(8),
      complianceRuleReference: id(9),
      activation: { mode: "Immediate" },
      effectiveUntil: null,
    },
  }),
  contentDigest: digest,
  createdAt: at,
  updatedAt: at,
  dataClassification: "Internal",
});
const record = () => ({
  profile: "DigitalReceiptTemplateSubmissionV1",
  ...scope,
  templateReference: id(6),
  familyReference: id(4),
  versionReference: id(7),
  draftRevision: 1,
  contentDigest: digest,
  authoredByReference: id(5),
  submittedByReference: id(10),
  operationReference: id(11),
  reviewLifecycleReference: id(12),
  reviewVersion: 2,
  validationEvidenceReference: id(13),
  checkedAt: at,
  validationValidUntil: until,
  submittedAt: submitted,
  auditReference: id(14),
  dataClassification: "Internal",
});
it("joins actual immutable Draft pins into only seven authored-content fields with distinct author and submitter", () => {
  const input = record(),
    snapshot = draft(),
    result = createDigitalReceiptTemplateAuthoredContent(input, snapshot);
  expect(Object.keys(parseDigitalReceiptTemplateSubmission(input))).toHaveLength(20);
  expect(Object.keys(result)).toEqual([
    "profile",
    "content",
    "authoredByReference",
    "submittedByReference",
    "familyReference",
    "reviewLifecycleReference",
    "reviewVersion",
  ]);
  expect(result.authoredByReference).not.toBe(result.submittedByReference);
  expect(result.content).toEqual(snapshot.content);
  expect(result.content).not.toBe(snapshot.content);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.content.requiredFields)).toBe(true);
  input.submittedByReference = id(20);
  expect(result.submittedByReference).toBe(id(10));
});
it("records historical evidence without imposing a current-clock lease or inventing independence", () => {
  const value = { ...record(), submittedByReference: id(5), checkedAt: submitted };
  expect(parseDigitalReceiptTemplateSubmission(value).checkedAt).toBe(submitted);
  expect(createDigitalReceiptTemplateAuthoredContent(value, draft()).submittedByReference).toBe(
    id(5),
  );
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "templateReference",
  "familyReference",
  "versionReference",
  "authoredByReference",
])("rejects mismatched immutable %s", (key) => {
  expect(() =>
    createDigitalReceiptTemplateAuthoredContent({ ...record(), [key]: id(30) }, draft()),
  ).toThrow(DigitalReceiptTemplateError);
});
it.each([{ draftRevision: 2 }, { contentDigest: "sha256:" + "b".repeat(64) }])(
  "rejects different immutable revision or digest %j",
  (change) => {
    expect(() =>
      createDigitalReceiptTemplateAuthoredContent({ ...record(), ...change }, draft()),
    ).toThrow(DigitalReceiptTemplateError);
  },
);
it("refuses a Draft authored after submission", () => {
  expect(() =>
    createDigitalReceiptTemplateAuthoredContent(record(), {
      ...draft(),
      createdAt: until,
      updatedAt: until,
    }),
  ).toThrow(DigitalReceiptTemplateError);
});
it.each([
  { reviewVersion: 1 },
  { reviewVersion: 2147483648 },
  { draftRevision: 0 },
  { draftRevision: 1.5 },
  { checkedAt: until },
  { validationValidUntil: submitted },
  { submittedAt: until },
  { checkedAt: "2026-10-05T10:00:00Z" },
  { validationValidUntil: null },
  { contentDigest: "a".repeat(64) },
  { contentDigest: "sha256:" + "A".repeat(64) },
  { validationEvidenceReference: "unknown" },
  { dataClassification: "Public" },
  { profile: "DigitalReceiptTemplateSubmissionV2" },
  { approvalReference: id(30) },
  { publishedAt: submitted },
  { content: draft().content },
])("refuses closed record or evidence-clock corruption %j", (change) => {
  expect(() => parseDigitalReceiptTemplateSubmission({ ...record(), ...change })).toThrow(
    DigitalReceiptTemplateError,
  );
});
it("rejects missing fields, arrays, inherited objects, symbols and accessors without invoking them", () => {
  const input = record(),
    getter = vi.fn(() => id(6));
  const { auditReference: _audit, ...missing } = input;
  void _audit;
  for (const value of [
    missing,
    Object.values(input),
    Object.assign(Object.create(input), input),
    { ...input, [Symbol("private")]: true },
    Object.defineProperty({ ...input }, "templateReference", { enumerable: true, get: getter }),
  ]) {
    expect(() => parseDigitalReceiptTemplateSubmission(value)).toThrow(DigitalReceiptTemplateError);
  }
  expect(getter).not.toHaveBeenCalled();
});
it("rejects malformed Draft getters through the same bounded public error", () => {
  const getter = vi.fn(() => draft().content);
  expect(() =>
    createDigitalReceiptTemplateAuthoredContent(
      record(),
      Object.defineProperty(draft(), "content", { enumerable: true, get: getter }),
    ),
  ).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
});
