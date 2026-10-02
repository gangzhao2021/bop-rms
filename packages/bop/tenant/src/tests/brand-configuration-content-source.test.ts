import { describe, expect, it, vi } from "vitest";
import {
  parseTenantBrandConfigurationContentRequest,
  parseTenantRecordedBrandConfiguration,
  tenantBrandConfigurationContent,
  tenantBrandConfigurationContentDigest,
} from "../index.js";
const id = (n: number) => "01909998-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T10:00:00.000Z";
const shape = (patch: Record<string, unknown> = {}) => ({
  configurationVersionReference: id(10),
  brandReference: id(2),
  configurationVersion: 1,
  lifecycle: "Draft",
  defaultLocale: "en-CA",
  supportedLocales: ["en-CA", "fr-CA"],
  mediaThemeReference: null,
  catalogSourceReference: id(12),
  platformTemplateReference: id(13),
  overrideAllowedFieldCodes: ["DISPLAY.THEME"],
  hardRequirementFieldCodes: ["SECURITY.REAUTH"],
  effectiveFrom: at,
  effectiveUntil: null,
  supersedesVersionReference: null,
  reasonCode: "INITIAL_CONFIGURATION",
  authoredByReference: id(20),
  approvedByReference: null,
  approvalEvidenceReference: null,
  publicationReference: null,
  createdAt: at,
  updatedAt: at,
  dataClassification: "ConfigurationMetadata",
  ...patch,
});
const request = {
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(20),
  purposeCode: "CATALOG_PRODUCT_CONTENT",
  configurationVersionReference: id(10),
  expectedBrandVersion: 1,
  originalIntentDigest: "sha256:" + "a".repeat(64),
  observedAt: at,
  validUntil: "2026-09-11T10:00:30.000Z",
};
describe("owning Brand content profile", () => {
  it("preserves the digest across allowed governance transitions", () => {
    const initial = tenantBrandConfigurationContentDigest(shape());
    for (const lifecycle of [
      "PendingApproval",
      "Approved",
      "Published",
      "Superseded",
      "Archived",
    ]) {
      const approved = lifecycle !== "PendingApproval";
      const published = ["Published", "Superseded", "Archived"].includes(lifecycle);
      expect(
        tenantBrandConfigurationContentDigest(
          shape({
            lifecycle,
            approvedByReference: approved ? id(21) : null,
            approvalEvidenceReference: approved ? id(22) : null,
            publicationReference: published ? id(23) : null,
            updatedAt: "2026-09-11T10:01:00.000Z",
          }),
        ),
      ).toBe(initial);
    }
  });
  it.each([
    { configurationVersionReference: id(99) },
    { brandReference: id(99) },
    { configurationVersion: 2, supersedesVersionReference: id(99) },
    { defaultLocale: "fr-CA" },
    { supportedLocales: ["en-CA"] },
    { mediaThemeReference: id(99) },
    { catalogSourceReference: id(99) },
    { platformTemplateReference: id(99) },
    { overrideAllowedFieldCodes: [] },
    { hardRequirementFieldCodes: [] },
    { effectiveFrom: "2026-09-11T10:01:00.000Z" },
    { effectiveUntil: "2026-09-11T11:00:00.000Z" },
    { reasonCode: "CHANGED" },
    { authoredByReference: id(99) },
    { createdAt: "2026-09-11T09:59:00.000Z" },
  ])("structural change invalidates content binding (%#)", (patch) => {
    expect(tenantBrandConfigurationContentDigest(shape(patch))).not.toBe(
      tenantBrandConfigurationContentDigest(shape()),
    );
  });
  it("sorts set members and detaches immutable output", () => {
    const input = shape();
    const result = tenantBrandConfigurationContent(input);
    expect(
      tenantBrandConfigurationContentDigest({ ...input, supportedLocales: ["fr-CA", "en-CA"] }),
    ).toBe(tenantBrandConfigurationContentDigest(input));
    input.supportedLocales.push("de-DE");
    expect(result.supportedLocales).toEqual(["en-CA", "fr-CA"]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.supportedLocales)).toBe(true);
    expect(Object.keys(result)).not.toContain("approvedByReference");
    expect(Object.keys(result)).not.toContain("publicationReference");
  });
  it("does not evaluate record or nested array accessors", () => {
    const getter = vi.fn(() => "en-CA");
    const record = shape();
    Object.defineProperty(record, "defaultLocale", { get: getter, enumerable: true });
    expect(() => parseTenantRecordedBrandConfiguration(record)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
    const nested = shape();
    Object.defineProperty(nested.supportedLocales, "0", { get: getter, enumerable: true });
    expect(() => parseTenantRecordedBrandConfiguration(nested)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { ...shape(), unsupported: true },
    { ...shape(), supportedLocales: new Array(2) },
    shape({
      lifecycle: "Published",
      approvedByReference: id(20),
      approvalEvidenceReference: id(22),
      publicationReference: id(23),
    }),
  ])("denies malformed metadata (%#)", (input) => {
    expect(() => parseTenantRecordedBrandConfiguration(input)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
  });
});
describe("Brand content query contract", () => {
  it("copies exact bounded current observation intent", () => {
    expect(parseTenantBrandConfigurationContentRequest(request)).toEqual(request);
  });
  it.each([
    {},
    { ...request, unsupported: true },
    { ...request, purposeCode: "OTHER_PURPOSE" },
    { ...request, validUntil: at },
    { ...request, validUntil: "2026-09-11T10:00:30.001Z" },
    { ...request, expectedBrandVersion: 0 },
    { ...request, tenantReference: "unrestricted" },
    { ...request, actorReference: "unrestricted" },
    { ...request, originalIntentDigest: "a".repeat(64) },
  ])("denies incomplete/unbound observation (%#)", (input) => {
    expect(() => parseTenantBrandConfigurationContentRequest(input)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
  });
  it("does not invoke a query accessor", () => {
    const getter = vi.fn(() => at);
    const input = { ...request };
    Object.defineProperty(input, "observedAt", { get: getter, enumerable: true });
    expect(() => parseTenantBrandConfigurationContentRequest(input)).toThrow(
      "TENANT_BRAND_CONFIGURATION_UNAVAILABLE",
    );
    expect(getter).not.toHaveBeenCalled();
  });
});
