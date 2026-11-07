import { expect, it, vi } from "vitest";
import { bindMerchantReceiptTemplateSubmitCommand as bind } from "./merchant-receipt-template-submit-command.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const submit = {
  command: "SubmitReview",
  operationReference: id(5),
  templateReference: id(6),
  expectedVersionReference: id(7),
  expectedRevision: 2,
};
const resolve = { ...submit, command: "ResolveOriginal", intentDigest: "sha256:" + "a".repeat(64) };
const invalid = (work: () => unknown) =>
  expect(work).toThrowError(expect.objectContaining({ code: "RECEIPT_TEMPLATE_INPUT_INVALID" }));
it("binds actual server scope and immutable draft pins to Submit without caller review or clocks", () => {
  const result = bind(submit, scope);
  expect(result.method).toBe("submit");
  expect(result.command).toEqual({
    profile: "DigitalReceiptTemplateSubmitV1",
    ...scope,
    operationReference: submit.operationReference,
    templateReference: submit.templateReference,
    expectedVersionReference: submit.expectedVersionReference,
    expectedRevision: 2,
    purposeCode: "RECEIPT_TEMPLATE_REVIEW",
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.command)).toBe(true);
  expect(Object.keys(result.command)).toHaveLength(10);
});
it("binds payload-free Resolve to exact original identity and digest", () => {
  const result = bind(resolve, scope);
  expect(result.method).toBe("resolve");
  expect(result.command).toMatchObject({
    ...scope,
    purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    profile: "DigitalReceiptTemplateSubmitResolveV1",
    intentDigest: resolve.intentDigest,
  });
  expect(Object.keys(result.command)).toHaveLength(11);
  expect(Object.keys(result.command)).not.toContain("content");
  expect(Object.isFrozen(result.command)).toBe(true);
});
it("uses the actual current manager identity, independently of historical draft author", () => {
  expect(bind(submit, { ...scope, actorReference: id(8) }).command.actorReference).toBe(id(8));
  expect(bind(submit, scope).command.actorReference).toBe(id(4));
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "scope",
  "reviewLifecycleReference",
  "reviewVersion",
  "validationEvidenceReference",
  "checkedAt",
  "validationValidUntil",
  "approvalValidUntil",
  "auditReference",
  "familyReference",
  "purposeCode",
  "profile",
  "fields",
  "content",
  "html",
])("rejects caller injection of %s", (key) => {
  invalid(() => bind({ ...submit, [key]: id(8) }, scope));
  invalid(() => bind({ ...resolve, [key]: id(8) }, scope));
});
it.each([0, -1, 1.5, 2147483648, "2", null, undefined, NaN, Infinity])(
  "rejects invalid revision %s for both commands",
  (expectedRevision) => {
    invalid(() => bind({ ...submit, expectedRevision }, scope));
    invalid(() => bind({ ...resolve, expectedRevision }, scope));
  },
);
it.each(["operationReference", "templateReference", "expectedVersionReference"])(
  "requires actual immutable UUIDv7 pin %s",
  (key) => {
    for (const value of [null, "not-a-reference", "01902501-0000-4000-8000-000000000001"]) {
      invalid(() => bind({ ...submit, [key]: value }, scope));
      invalid(() => bind({ ...resolve, [key]: value }, scope));
    }
  },
);
it("rejects initial unsaved draft pins and Submit digest, missing Resolve digest and unsupported commands", () => {
  invalid(() =>
    bind(
      { ...submit, templateReference: null, expectedVersionReference: null, expectedRevision: 0 },
      scope,
    ),
  );
  invalid(() => bind({ ...submit, intentDigest: resolve.intentDigest }, scope));
  invalid(() => bind({ ...submit, command: "ResolveOriginal" }, scope));
  invalid(() => bind({ ...resolve, intentDigest: "a".repeat(64) }, scope));
  invalid(() => bind({ ...submit, command: "Approve" }, scope));
});
it("rejects getter descriptors without invoking them and does not retain mutable caller input", () => {
  const getter = vi.fn(() => "SubmitReview"),
    body = { ...submit };
  Object.defineProperty(body, "command", { enumerable: true, get: getter });
  invalid(() => bind(body, scope));
  expect(getter).not.toHaveBeenCalled();
  const revisionGetter = vi.fn(() => 2),
    nested = { ...submit };
  Object.defineProperty(nested, "expectedRevision", { enumerable: true, get: revisionGetter });
  invalid(() => bind(nested, scope));
  expect(revisionGetter).not.toHaveBeenCalled();
  const mutable = { ...submit },
    result = bind(mutable, scope);
  mutable.expectedRevision = 3;
  expect(result.command.expectedRevision).toBe(2);
});
it("rejects inherited, sparse and nonenumerable inputs plus malformed actual server scope", () => {
  invalid(() => bind(Object.assign(Object.create({ inherited: true }), submit), scope));
  invalid(() => bind([submit], scope));
  const nonenumerable = { ...submit };
  Object.defineProperty(nonenumerable, "command", { enumerable: false, value: "SubmitReview" });
  invalid(() => bind(nonenumerable, scope));
  invalid(() => bind(submit, { ...scope, actorReference: "invalid" }));
  invalid(() => bind(submit, Object.assign(Object.create({ actorReference: id(4) }), scope)));
  const extraScope = { ...scope, extra: true };
  invalid(() => bind(submit, extraScope));
  const getter = vi.fn(() => id(4)),
    identity = { ...scope };
  Object.defineProperty(identity, "actorReference", { enumerable: true, get: getter });
  invalid(() => bind(submit, identity));
  expect(getter).not.toHaveBeenCalled();
});
