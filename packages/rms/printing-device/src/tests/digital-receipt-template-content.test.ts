import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  digitalReceiptRequiredFields,
  parseDigitalReceiptTemplateVersion,
} from "../contracts/digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateContent,
  materializeDigitalReceiptTemplateContent,
  assertDigitalReceiptTemplateContentEnvelope,
} from "../contracts/digital-receipt-template-content.js";
const id = (n: number) => `0190ed11-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-05T14:00:00.000Z",
  later = "2026-10-06T14:00:00.000Z";
function content() {
  return {
    profile: "DigitalReceiptTemplateContentV2",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    templateReference: id(4),
    versionReference: id(5),
    versionNumber: 1,
    versionCode: "RECEIPT_V1",
    locale: "en-CA",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: id(6),
    complianceRuleReference: id(7),
    requiredFields: [...digitalReceiptRequiredFields],
    activation: { mode: "Immediate" },
    effectiveUntil: null,
    dataClassification: "Internal",
  };
}
const publish = (value: unknown = content(), publishedAt = later) =>
  materializeDigitalReceiptTemplateContent({
    content: value,
    publicationReference: id(8),
    publishedAt,
  });
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const invalid = (work: () => unknown) => expect(work).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
describe("authored digital receipt content and publication envelope", () => {
  it("keeps a fixed reviewed digest while delayed Immediate publication binds actual Release/time", () => {
    const source = parseDigitalReceiptTemplateContent(content()),
      reviewedDigest = digest(source);
    const early = publish(source, at),
      delayed = publish(source, later);
    expect(early.effectiveFrom).toBe(at);
    expect(delayed.effectiveFrom).toBe(later);
    expect(delayed.publishedAt).toBe(later);
    expect(delayed.publicationReference).toBe(id(8));
    expect(digest(source)).toBe(reviewedDigest);
    expect(source).not.toHaveProperty("publishedAt");
    expect(source).not.toHaveProperty("publicationReference");
    expect(parseDigitalReceiptTemplateVersion(delayed)).toEqual(delayed);
    expect(assertDigitalReceiptTemplateContentEnvelope(source, delayed)).toEqual(delayed);
  });
  it("copies and freezes the closed content, activation and required field array", () => {
    const input = content(),
      parsed = parseDigitalReceiptTemplateContent(input);
    input.requiredFields.pop();
    input.activation.mode = "Scheduled";
    input.locale = "fr-CA";
    expect(parsed.locale).toBe("en-CA");
    expect(parsed.activation).toEqual({ mode: "Immediate" });
    expect(parsed.requiredFields).toEqual(digitalReceiptRequiredFields);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.activation)).toBe(true);
    expect(Object.isFrozen(parsed.requiredFields)).toBe(true);
    expect(Object.isFrozen(publish(parsed))).toBe(true);
  });
  it("preserves all exact scope, identity, locale and artifact pins in the published envelope", () => {
    const source = { ...content(), versionNumber: 4, versionCode: "RECEIPT_V4", locale: "fr-CA" };
    expect(publish(source)).toMatchObject({
      brandReference: id(2),
      storeReference: id(3),
      templateReference: id(4),
      versionReference: id(5),
      versionNumber: 4,
      versionCode: "RECEIPT_V4",
      locale: "fr-CA",
      layoutDefinitionReference: id(6),
      complianceRuleReference: id(7),
    });
    expect(publish(source)).not.toHaveProperty("tenantReference");
  });
  it("uses explicit Scheduled activation and half-open end without retargeting after its time", () => {
    const source = {
      ...content(),
      activation: { mode: "Scheduled", effectiveFrom: later },
      effectiveUntil: "2026-10-07T14:00:00.000Z",
    };
    expect(publish(source, at).effectiveFrom).toBe(later);
    expect(publish(source, later).effectiveFrom).toBe(later);
    invalid(() => publish(source, "2026-10-06T14:00:00.001Z"));
    invalid(() => parseDigitalReceiptTemplateContent({ ...source, effectiveUntil: later }));
  });
  it("allows an authored Immediate end but refuses materialization at or after that end", () => {
    const source = { ...content(), effectiveUntil: later };
    expect(parseDigitalReceiptTemplateContent(source).effectiveUntil).toBe(later);
    expect(publish(source, at).effectiveUntil).toBe(later);
    invalid(() => publish(source, later));
    invalid(() => publish(source, "2026-10-07T14:00:00.000Z"));
  });
  it.each([
    "brandReference",
    "storeReference",
    "templateReference",
    "versionReference",
    "layoutDefinitionReference",
    "complianceRuleReference",
  ] as const)("rejects valid but substituted envelope %s", (key) => {
    const source = content(),
      envelope = publish(source);
    invalid(() =>
      assertDigitalReceiptTemplateContentEnvelope(source, { ...envelope, [key]: id(99) }),
    );
  });
  it.each([
    { locale: "fr-CA" },
    { versionNumber: 2 },
    { versionCode: "RECEIPT_V2" },
    { effectiveFrom: "2026-10-06T14:00:00.001Z" },
    { effectiveUntil: "2026-10-07T14:00:00.000Z" },
  ])("rejects envelope content drift", (patch) => {
    invalid(() =>
      assertDigitalReceiptTemplateContentEnvelope(content(), { ...publish(), ...patch }),
    );
  });
  it("does not silently reorder required fields when matching the original reviewed content", () => {
    const source = content(),
      envelope = publish(source);
    invalid(() =>
      assertDigitalReceiptTemplateContentEnvelope(source, {
        ...envelope,
        requiredFields: [...envelope.requiredFields].reverse(),
      }),
    );
    const reversed = { ...source, requiredFields: [...source.requiredFields].reverse() };
    expect(
      assertDigitalReceiptTemplateContentEnvelope(reversed, publish(reversed)).requiredFields,
    ).toEqual(reversed.requiredFields);
  });
  it.each([
    "tenantReference",
    "brandReference",
    "storeReference",
    "templateReference",
    "versionReference",
    "layoutDefinitionReference",
    "complianceRuleReference",
  ] as const)("rejects non-UUID7 content %s", (key) => {
    invalid(() =>
      parseDigitalReceiptTemplateContent({
        ...content(),
        [key]: "0190ed11-0000-4000-8000-000000000001",
      }),
    );
  });
  it.each([
    { profile: "DigitalReceiptTemplateContentV3" },
    { versionNumber: 0 },
    { versionNumber: 1.5 },
    { versionNumber: Number.MAX_SAFE_INTEGER + 1 },
    { versionCode: "<script>" },
    { locale: "en_CA" },
    { dataContractVersion: 2 },
    { renderEngineVersion: 2 },
    { outputProfile: "PhysicalPrinter" },
    { dataClassification: "Public" },
  ])("rejects unsupported or unsafe scalar fields", (patch) => {
    invalid(() => parseDigitalReceiptTemplateContent({ ...content(), ...patch }));
  });
  it.each([
    { publicationReference: id(8) },
    { publishedAt: at },
    { approvalEvidenceReference: id(9) },
    { providerReady: true },
    { validUntil: later },
    { layoutHtml: "<script>" },
    { credential: "synthetic" },
  ])("rejects publication, qualification, HTML and credential injection", (patch) => {
    invalid(() => parseDigitalReceiptTemplateContent({ ...content(), ...patch }));
  });
  it.each([
    { mode: "Immediate", effectiveFrom: at },
    { mode: "Scheduled" },
    { mode: "Automatic" },
    { mode: "Scheduled", effectiveFrom: "2026-10-06T14:00:00Z" },
    { mode: "Scheduled", effectiveFrom: "2026-10-06T14:00:00.000+00:00" },
    { mode: "Scheduled", effectiveFrom: "2026-02-30T14:00:00.000Z" },
  ])("rejects open or noncanonical activation", (activation) => {
    invalid(() => parseDigitalReceiptTemplateContent({ ...content(), activation }));
  });
  it("rejects missing, duplicated, unknown, sparse and accessor field arrays without invoking getters", () => {
    const missing = content().requiredFields.slice(1),
      duplicated = [...digitalReceiptRequiredFields.slice(1), "Total"];
    invalid(() => parseDigitalReceiptTemplateContent({ ...content(), requiredFields: missing }));
    invalid(() => parseDigitalReceiptTemplateContent({ ...content(), requiredFields: duplicated }));
    invalid(() =>
      parseDigitalReceiptTemplateContent({
        ...content(),
        requiredFields: [...digitalReceiptRequiredFields.slice(1), "Account"],
      }),
    );
    const sparse = [...digitalReceiptRequiredFields];
    delete sparse[0];
    invalid(() => parseDigitalReceiptTemplateContent({ ...content(), requiredFields: sparse }));
    const getter = vi.fn(() => "Issuer"),
      accessor = [...digitalReceiptRequiredFields];
    Object.defineProperty(accessor, "0", { enumerable: true, get: getter });
    invalid(() => parseDigitalReceiptTemplateContent({ ...content(), requiredFields: accessor }));
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects accessor, hidden, inherited or missing closed content properties", () => {
    const getter = vi.fn(() => id(1)),
      source = content();
    Object.defineProperty(source, "tenantReference", { enumerable: true, get: getter });
    invalid(() => parseDigitalReceiptTemplateContent(source));
    expect(getter).not.toHaveBeenCalled();
    const hidden = content();
    Object.defineProperty(hidden, "locale", { value: "en-CA", enumerable: false });
    invalid(() => parseDigitalReceiptTemplateContent(hidden));
    invalid(() => parseDigitalReceiptTemplateContent(Object.create(content())));
    const { effectiveUntil: ignored, ...missing } = content();
    void ignored;
    invalid(() => parseDigitalReceiptTemplateContent(missing));
  });
  it("never invokes activation or materialization input getters", () => {
    const getter = vi.fn(() => "Immediate");
    invalid(() =>
      parseDigitalReceiptTemplateContent({
        ...content(),
        activation: Object.defineProperty({}, "mode", { enumerable: true, get: getter }),
      }),
    );
    const input = { content: content(), publicationReference: id(8), publishedAt: at };
    Object.defineProperty(input, "publishedAt", { enumerable: true, get: getter });
    invalid(() => materializeDigitalReceiptTemplateContent(input));
    expect(getter).not.toHaveBeenCalled();
  });
  it("requires strict actual publication metadata and rejects extra authority input", () => {
    invalid(() => publish(content(), "2026-10-06T14:00:00Z"));
    invalid(() =>
      materializeDigitalReceiptTemplateContent({
        content: content(),
        publicationReference: "bad",
        publishedAt: later,
      }),
    );
    const extra = {
      content: content(),
      publicationReference: id(8),
      publishedAt: later,
      approved: true,
    };
    invalid(() => materializeDigitalReceiptTemplateContent(extra));
    invalid(() =>
      assertDigitalReceiptTemplateContentEnvelope(content(), { ...publish(), approved: true }),
    );
  });
});
