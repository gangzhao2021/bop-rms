import { expect, it } from "vitest";
import { bindMerchantReceiptTemplateLifecycleCommand as bind } from "./merchant-receipt-template-lifecycle-command.js";

const id = (n: number) => "01902421-1700-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const body = {
  command: "Approve",
  operationReference: id(10),
  templateReference: id(11),
  expectedVersionReference: id(12),
  expectedRevision: 1,
  reviewLifecycleReference: id(13),
  expectedReviewVersion: 2,
  expectedReviewOperationReference: id(14),
};
it.each(["Approve", "Publish"])("binds %s to server identity and exact review head", (command) => {
  const result = bind({ ...body, command }, scope);
  expect(result.method).toBe("execute");
  expect(result.command).toMatchObject({
    ...scope,
    action: command,
    purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    expectedReviewOperationReference: id(14),
  });
});
it.each(["Approve", "Publish"])("retains the original %s action on resolution", (action) => {
  const result = bind(
    { ...body, command: "ResolveOriginal", action, intentDigest: "sha256:" + "a".repeat(64) },
    scope,
  );
  expect(result.method).toBe("resolve");
  expect(result.command).toMatchObject({
    action,
    expectedVersionReference: id(12),
    intentDigest: "sha256:" + "a".repeat(64),
  });
});
it.each([
  "actorReference",
  "tenantReference",
  "approvalEvidenceReference",
  "approvalValidUntil",
  "purposeCode",
  "action",
  "unexpected",
])("rejects browser supplied %s", (key) => {
  expect(() => bind({ ...body, [key]: id(40) }, scope)).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
});
it.each([
  { ...body, command: "SubmitReview" },
  { ...body, operationReference: body.expectedReviewOperationReference },
  { ...body, expectedReviewVersion: 2147483647 },
  { ...body, expectedRevision: 0 },
  { ...body, command: "ResolveOriginal", action: "Approve", intentDigest: "bad" },
  { ...body, command: "ResolveOriginal", intentDigest: "sha256:" + "a".repeat(64) },
])("rejects malformed or unsupported lifecycle intents", (input) => {
  expect(() => bind(input, scope)).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
});
it("rejects accessors without invoking them", () => {
  let read = false;
  const input = { ...body };
  Object.defineProperty(input, "command", {
    enumerable: true,
    get() {
      read = true;
      return "Approve";
    },
  });
  expect(() => bind(input, scope)).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
  expect(read).toBe(false);
});
