import { expect, it, vi } from "vitest";
import {
  parseDigitalReceiptTemplateDraftFields,
  createDigitalReceiptTemplateDraftContent,
} from "../contracts/digital-receipt-template-draft-fields.js";
import {
  DigitalReceiptTemplateError,
  digitalReceiptRequiredFields,
} from "../contracts/digital-receipt-template.js";
const id = (n: number) => `01902501-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-05T10:00:00.000Z",
  until = "2026-10-06T10:00:00.000Z";
const fields = () => ({
  locale: "en-CA",
  layoutDefinitionReference: id(6),
  complianceRuleReference: id(7),
  activation: { mode: "Immediate" },
  effectiveUntil: null,
});
const input = () => ({
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  templateReference: id(4),
  versionReference: id(5),
  versionNumber: 1,
  fields: fields(),
});
const denied = (work: () => unknown) => {
  expect(work).toThrow(DigitalReceiptTemplateError);
  expect(work).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
};
it("accepts only five editable fields with detached frozen activation", () => {
  const raw = fields(),
    parsed = parseDigitalReceiptTemplateDraftFields(raw);
  raw.locale = "fr-CA";
  raw.activation.mode = "Scheduled";
  expect(parsed.locale).toBe("en-CA");
  expect(parsed.activation).toEqual({ mode: "Immediate" });
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.activation)).toBe(true);
  expect(Object.keys(parsed)).toHaveLength(5);
});
it("constructs fixed ContentV2 from actual supplied server pins", () => {
  const raw = input(),
    content = createDigitalReceiptTemplateDraftContent(raw);
  expect(content).toMatchObject({
    profile: "DigitalReceiptTemplateContentV2",
    tenantReference: id(1),
    templateReference: id(4),
    versionReference: id(5),
    versionNumber: 1,
    versionCode: "RECEIPT_1",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    dataClassification: "Internal",
  });
  expect(content.requiredFields).toEqual(digitalReceiptRequiredFields);
  expect(Object.isFrozen(content.requiredFields)).toBe(true);
  expect(content).not.toHaveProperty("publicationReference");
  expect(content).not.toHaveProperty("publishedAt");
});
it("distinct immutable Draft references can retain the same next publication number", () => {
  const first = createDigitalReceiptTemplateDraftContent(input()),
    second = createDigitalReceiptTemplateDraftContent({
      ...input(),
      versionReference: id(8),
      fields: { ...fields(), locale: "fr-CA" },
    });
  expect(first.versionReference).not.toBe(second.versionReference);
  expect(first.versionNumber).toBe(second.versionNumber);
  expect(second.versionCode).toBe("RECEIPT_1");
  expect(first.locale).toBe("en-CA");
});
it("scheduled fields require a strictly later explicit end but do not infer current time", () => {
  expect(
    parseDigitalReceiptTemplateDraftFields({
      ...fields(),
      activation: { mode: "Scheduled", effectiveFrom: at },
      effectiveUntil: until,
    }).activation,
  ).toEqual({ mode: "Scheduled", effectiveFrom: at });
  expect(
    parseDigitalReceiptTemplateDraftFields({
      ...fields(),
      activation: { mode: "Scheduled", effectiveFrom: at },
    }).effectiveUntil,
  ).toBeNull();
  for (const end of [at, "2026-10-04T10:00:00.000Z"])
    denied(() =>
      parseDigitalReceiptTemplateDraftFields({
        ...fields(),
        activation: { mode: "Scheduled", effectiveFrom: at },
        effectiveUntil: end,
      }),
    );
});
it.each(["en-ca", "EN-CA", "en_CA", "en-Canada", "<b>en</b>", "en\n", ""])(
  "rejects invalid locale %s",
  (locale) => denied(() => parseDigitalReceiptTemplateDraftFields({ ...fields(), locale })),
);
it.each([
  "versionReference",
  "versionNumber",
  "profile",
  "requiredFields",
  "publishedAt",
  "professionalReviewStatus",
  "validUntil",
])("forbids forged authored server field %s", (key) =>
  denied(() => parseDigitalReceiptTemplateDraftFields({ ...fields(), [key]: id(9) })),
);
it.each([
  null,
  {},
  [],
  { mode: "Immediate", effectiveFrom: at },
  { mode: "Scheduled" },
  { mode: "Scheduled", effectiveFrom: "2026-10-05T10:00:00Z" },
  { mode: "Scheduled", effectiveFrom: "2026-10-05T10:00:00.000+00:00" },
  { mode: "Later" },
])("rejects malformed activation %j", (activation) =>
  denied(() => parseDigitalReceiptTemplateDraftFields({ ...fields(), activation })),
);
it.each([undefined, "", at.slice(0, -1), "2026-02-30T10:00:00.000Z"])(
  "rejects noncanonical end %s",
  (effectiveUntil) =>
    denied(() => parseDigitalReceiptTemplateDraftFields({ ...fields(), effectiveUntil })),
);
it("refuses non-v7 references and missing fields", () => {
  denied(() =>
    parseDigitalReceiptTemplateDraftFields({
      ...fields(),
      layoutDefinitionReference: "01902501-0000-4000-8000-000000000006",
    }),
  );
  const { locale: _locale, ...missing } = fields();
  void _locale;
  denied(() => parseDigitalReceiptTemplateDraftFields(missing));
});
it("does not invoke getters or admit hidden/symbol/inherited fields", () => {
  const getter = vi.fn(() => "en-CA"),
    raw = fields();
  Object.defineProperty(raw, "locale", { enumerable: true, get: getter });
  denied(() => parseDigitalReceiptTemplateDraftFields(raw));
  expect(getter).not.toHaveBeenCalled();
  denied(() =>
    parseDigitalReceiptTemplateDraftFields(Object.assign(Object.create({ unknown: 1 }), fields())),
  );
  const hidden = fields();
  Object.defineProperty(hidden, "extra", { value: true });
  denied(() => parseDigitalReceiptTemplateDraftFields(hidden));
  denied(() => parseDigitalReceiptTemplateDraftFields({ ...fields(), [Symbol("secret")]: 1 }));
});
it("builder rejects extra metadata, invalid numbers and malformed pins with canonical error", () => {
  const extra = { ...input(), publicationReference: id(9) };
  denied(() => createDigitalReceiptTemplateDraftContent(extra));
  for (const versionNumber of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"])
    denied(() => createDigitalReceiptTemplateDraftContent({ ...input(), versionNumber }));
  for (const key of [
    "tenantReference",
    "brandReference",
    "storeReference",
    "templateReference",
    "versionReference",
  ] as const)
    denied(() => createDigitalReceiptTemplateDraftContent({ ...input(), [key]: "invalid" }));
});
it("builder input descriptors are checked before reading fields", () => {
  const getter = vi.fn(() => fields()),
    raw = input();
  Object.defineProperty(raw, "fields", { enumerable: true, get: getter });
  denied(() => createDigitalReceiptTemplateDraftContent(raw));
  expect(getter).not.toHaveBeenCalled();
});
