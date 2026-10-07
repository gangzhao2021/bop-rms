import { expect, it, vi } from "vitest";
import { parseDigitalReceiptTemplatePublishedCurrent } from "../contracts/digital-receipt-template-published-current.js";
import { createDigitalReceiptTemplateDraftContent } from "../contracts/digital-receipt-template-draft-fields.js";
import { materializeDigitalReceiptTemplateContent } from "../contracts/digital-receipt-template-content.js";
import { DigitalReceiptTemplateError } from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T10:00:00.000Z",
  observed = "2026-10-05T10:01:00.000Z",
  until = "2026-10-05T10:01:05.000Z";
function packet() {
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  };
  const currentVersion = materializeDigitalReceiptTemplateContent({
    content: createDigitalReceiptTemplateDraftContent({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      templateReference: id(5),
      versionReference: id(6),
      versionNumber: 1,
      fields: {
        locale: "en-CA",
        layoutDefinitionReference: id(7),
        complianceRuleReference: id(8),
        activation: { mode: "Immediate" },
        effectiveUntil: null,
      },
    }),
    publicationReference: id(9),
    publishedAt: at,
  });
  return {
    profile: "DigitalReceiptTemplatePublishedCurrentV1",
    ...scope,
    templateReference: id(5),
    locale: "en-CA",
    currentVersion,
    observedAt: observed,
    validUntil: until,
    professionalReviewStatus: "NotEvaluated",
    legalConclusion: "NotEvaluated",
  };
}
it("returns exactly twelve detached frozen fields with an effective actual version and no renewed approval requirement", () => {
  const input = packet(),
    p = parseDigitalReceiptTemplatePublishedCurrent(input);
  expect(Object.keys(p)).toHaveLength(12);
  expect(Object.keys(p.currentVersion)).toHaveLength(17);
  expect(p.currentVersion.publishedAt).toBe(at);
  expect(p.professionalReviewStatus).toBe("NotEvaluated");
  expect(p.legalConclusion).toBe("NotEvaluated");
  expect(p.currentVersion).not.toBe(input.currentVersion);
  expect(p.currentVersion.requiredFields).not.toBe(input.currentVersion.requiredFields);
  expect(Object.isFrozen(p)).toBe(true);
  expect(Object.isFrozen(p.currentVersion.requiredFields)).toBe(true);
  input.actorReference = id(40);
  expect(p.actorReference).toBe(id(4));
  expect("approvalValidUntil" in p).toBe(false);
});
it("accepts exact current activation and a finite later end without selecting a guessed version", () => {
  const input = packet(),
    p = parseDigitalReceiptTemplatePublishedCurrent({
      ...input,
      observedAt: at,
      validUntil: "2026-10-05T10:00:00.001Z",
      currentVersion: { ...input.currentVersion, effectiveUntil: observed },
    });
  expect(p.currentVersion.effectiveFrom).toBe(p.observedAt);
  expect(p.templateReference).not.toBe(p.currentVersion.versionReference);
});
it.each([
  { brandReference: id(40) },
  { storeReference: id(40) },
  { templateReference: id(40) },
  { locale: "fr-CA" },
  { locale: "not a locale" },
  { tenantReference: "bad" },
  { actorReference: null },
  { currentVersion: null },
  { validUntil: observed },
  { validUntil: "2026-10-05T10:01:05.001Z" },
  { observedAt: "2026-10-05T10:01:00Z" },
  { professionalReviewStatus: "Approved" },
  { legalConclusion: "Pass" },
  { approvalEvidence: {} },
  { providerReady: true },
])("rejects incoherent or falsely qualified current packet %j", (change) => {
  expect(() => parseDigitalReceiptTemplatePublishedCurrent({ ...packet(), ...change })).toThrow(
    DigitalReceiptTemplateError,
  );
});
it.each([
  { publishedAt: "2026-10-05T10:01:00.001Z", effectiveFrom: "2026-10-05T10:01:00.001Z" },
  { effectiveFrom: "2026-10-05T10:01:00.001Z" },
  { effectiveUntil: observed },
  { effectiveUntil: at },
  { versionReference: "bad" },
  { renderEngineVersion: 2 },
  { profile: "DigitalReceiptTemplateVersionV2" },
])("rejects future, expired or malformed actual publication envelope %j", (change) => {
  const p = packet();
  expect(() =>
    parseDigitalReceiptTemplatePublishedCurrent({
      ...p,
      currentVersion: { ...p.currentVersion, ...change },
    }),
  ).toThrow(DigitalReceiptTemplateError);
});
it("rejects accessors and extra source credentials without invoking a getter", () => {
  const p = packet(),
    getter = vi.fn(() => p.currentVersion);
  Object.defineProperty(p, "currentVersion", { enumerable: true, get: getter });
  expect(() => parseDigitalReceiptTemplatePublishedCurrent(p)).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
  const good = packet(),
    nested = { ...good.currentVersion };
  Object.defineProperty(nested, "publicationReference", { enumerable: true, get: getter });
  expect(() =>
    parseDigitalReceiptTemplatePublishedCurrent({ ...good, currentVersion: nested }),
  ).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parseDigitalReceiptTemplatePublishedCurrent({ ...good, credentials: { secret: "refused" } }),
  ).toThrow(DigitalReceiptTemplateError);
});
it("refuses sparse or accessor-bearing required fields using the actual public version parser", () => {
  const p = packet(),
    sparse = new Array(13);
  expect(() =>
    parseDigitalReceiptTemplatePublishedCurrent({
      ...p,
      currentVersion: { ...p.currentVersion, requiredFields: sparse },
    }),
  ).toThrow(DigitalReceiptTemplateError);
  const fields = [...p.currentVersion.requiredFields],
    getter = vi.fn(() => "Issuer");
  Object.defineProperty(fields, "0", { enumerable: true, get: getter });
  expect(() =>
    parseDigitalReceiptTemplatePublishedCurrent({
      ...p,
      currentVersion: { ...p.currentVersion, requiredFields: fields },
    }),
  ).toThrow(DigitalReceiptTemplateError);
  expect(getter).not.toHaveBeenCalled();
});
