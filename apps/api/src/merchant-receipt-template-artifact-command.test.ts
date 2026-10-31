import { expect, it, vi } from "vitest";
import { digitalReceiptRequiredFields } from "@rms/printing-device";
import { bindMerchantReceiptTemplateArtifactCommand } from "./merchant-receipt-template-artifact-command.js";
const id = (n: number) => `0190ed34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  actorReference: id(4),
};
const layout = {
  profile: "AccessibleDigitalReceiptLayoutV1",
  dataContractVersion: 1,
  renderEngineVersion: 1,
  outputProfile: "AccessibleDigitalReceipt",
  requiredFields: [...digitalReceiptRequiredFields],
};
const compliance = {
  profile: "DigitalReceiptRequiredFieldRuleV1",
  dataContractVersion: 1,
  requiredFields: [...digitalReceiptRequiredFields],
  professionalReviewStatus: "NotEvaluated",
  legalConclusion: "NotEvaluated",
};
const save = (content: unknown = layout) => ({
  command: "SaveArtifact",
  operationReference: id(5),
  expectedArtifactReference: null,
  expectedRevision: 0,
  content,
});
it("binds actual acquired scope and software-only Layout intent", () => {
  const result = bindMerchantReceiptTemplateArtifactCommand(save(), scope, "Layout");
  expect(result.method).toBe("save");
  expect(result.command).toMatchObject({
    ...scope,
    artifactKind: "Layout",
    purposeCode: "RECEIPT_TEMPLATE_ARTIFACT",
    profile: "DigitalReceiptTemplateArtifactSaveV1",
  });
  expect(Object.isFrozen(result.command)).toBe(true);
});
it("registers field rules without claiming professional or legal approval", () => {
  const result = bindMerchantReceiptTemplateArtifactCommand(save(compliance), scope, "Compliance");
  expect(result.command).toMatchObject({
    artifactKind: "Compliance",
    content: { professionalReviewStatus: "NotEvaluated", legalConclusion: "NotEvaluated" },
  });
});
it("Resolve sends no artifact content or regenerated result", () => {
  const result = bindMerchantReceiptTemplateArtifactCommand(
    {
      command: "ResolveOriginal",
      operationReference: id(5),
      expectedArtifactReference: null,
      expectedRevision: 0,
      intentDigest: "sha256:" + "a".repeat(64),
    },
    scope,
    "Layout",
  );
  expect(result.method).toBe("resolve");
  expect(result.command).not.toHaveProperty("content");
});
it.each([
  "tenantReference",
  "actorReference",
  "permission",
  "artifactReference",
  "auditReference",
  "professionalReview",
])("refuses injected browser %s", (key) => {
  expect(() =>
    bindMerchantReceiptTemplateArtifactCommand({ ...save(), [key]: id(9) }, scope, "Layout"),
  ).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
});
it.each([
  { ...layout, html: "<script>forbidden</script>" },
  { ...layout, requiredFields: [...digitalReceiptRequiredFields].reverse() },
  { ...compliance, professionalReviewStatus: "Approved" },
  { ...compliance, legalConclusion: "Compliant" },
])("refuses unsupported software or professional conclusions", (content) => {
  expect(() =>
    bindMerchantReceiptTemplateArtifactCommand(
      save(content),
      scope,
      content.profile === "DigitalReceiptRequiredFieldRuleV1" ? "Compliance" : "Layout",
    ),
  ).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
});
it("does not invoke a command accessor", () => {
  const body = save(),
    getter = vi.fn(() => "SaveArtifact");
  Object.defineProperty(body, "command", { enumerable: true, get: getter });
  expect(() => bindMerchantReceiptTemplateArtifactCommand(body, scope, "Layout")).toThrow(
    "RECEIPT_TEMPLATE_INPUT_INVALID",
  );
  expect(getter).not.toHaveBeenCalled();
});
