import { expect, it, vi } from "vitest";
import { bindMerchantReceiptTemplateDraftCommand as bind } from "./merchant-receipt-template-draft-command.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const fields = {
  locale: "en-CA",
  layoutDefinitionReference: id(5),
  complianceRuleReference: id(6),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
};
const save = {
  command: "SaveDraft",
  operationReference: id(7),
  templateReference: null,
  expectedVersionReference: null,
  expectedRevision: 0,
  fields,
};
it("binds actual scope and initial intent without caller-created identities", () => {
  const result = bind(save, scope);
  expect(result.method).toBe("save");
  if (result.method !== "save") throw new Error("expected save");
  expect(result.command).toMatchObject({
    ...scope,
    purposeCode: "RECEIPT_TEMPLATE_AUTHORING",
    templateReference: null,
    expectedVersionReference: null,
    expectedRevision: 0,
  });
  expect(Object.isFrozen(result.command)).toBe(true);
  expect(Object.isFrozen(result.command.fields)).toBe(true);
});
it("binds recovery to the same original pins without retaining fields", () => {
  const result = bind(
    {
      command: "ResolveOriginal",
      operationReference: id(7),
      templateReference: null,
      expectedVersionReference: null,
      expectedRevision: 0,
      intentDigest: "sha256:" + "a".repeat(64),
    },
    scope,
  );
  expect(result.method).toBe("resolve");
  expect(Object.keys(result.command)).not.toContain("fields");
});
it.each([
  "tenantReference",
  "actorReference",
  "familyReference",
  "versionReference",
  "publishedAt",
  "versionNumber",
  "approvedByReference",
])("rejects caller supplied authority or output field %s", (key) => {
  expect(() => bind({ ...save, [key]: id(8) }, scope)).toThrowError(
    expect.objectContaining({ code: "RECEIPT_TEMPLATE_INPUT_INVALID" }),
  );
});
it("rejects getter input without executing it", () => {
  const getter = vi.fn(() => "SaveDraft");
  const body = { ...save };
  Object.defineProperty(body, "command", { enumerable: true, get: getter });
  expect(() => bind(body, scope)).toThrowError();
  expect(getter).not.toHaveBeenCalled();
});
it("rejects a caller-created initial root and half-filled revision pins", () => {
  expect(() => bind({ ...save, templateReference: id(8) }, scope)).toThrowError();
  expect(() =>
    bind({ ...save, expectedVersionReference: id(8), expectedRevision: 1 }, scope),
  ).toThrowError();
});
