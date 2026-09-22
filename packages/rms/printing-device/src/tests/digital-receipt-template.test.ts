import { describe, expect, it } from "vitest";
import {
  digitalReceiptRequiredFields,
  parseDigitalReceiptTemplateVersion,
  resolveDigitalReceiptTemplate,
} from "../contracts/digital-receipt-template.js";
const id = (n: number) => "0190ed11-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-12T12:00:00.000Z";
function version() {
  return {
    templateReference: id(1),
    versionReference: id(2),
    versionNumber: 1,
    versionCode: "RECEIPT_V1",
    brandReference: id(3),
    storeReference: id(4),
    locale: "en-CA",
    dataContractVersion: 1,
    renderEngineVersion: 1,
    outputProfile: "AccessibleDigitalReceipt",
    layoutDefinitionReference: id(5),
    complianceRuleReference: id(6),
    requiredFields: [...digitalReceiptRequiredFields],
    publicationReference: id(7),
    publishedAt: at,
    effectiveFrom: at,
    effectiveUntil: null,
  };
}
const resolve = (versions: unknown, observedAt = at, locale = "en-CA") =>
  resolveDigitalReceiptTemplate({
    brandReference: id(3),
    storeReference: id(4),
    templateReference: id(1),
    observedAt,
    locale,
    versions,
  });
describe("digital receipt template version", () => {
  it("captures immutable version and receipt fields without retaining caller arrays", () => {
    const input = version(),
      result = parseDigitalReceiptTemplateVersion(input);
    input.requiredFields.pop();
    expect(result.requiredFields).toHaveLength(digitalReceiptRequiredFields.length);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.requiredFields)).toBe(true);
    expect(resolve([version()])).toEqual(result);
  });
  it("resolves half-open periods exactly at a template change", () => {
    const until = "2026-09-12T13:00:00.000Z";
    const first = { ...version(), effectiveUntil: until };
    const next = {
      ...version(),
      versionReference: id(8),
      versionNumber: 2,
      versionCode: "RECEIPT_V2",
      effectiveFrom: until,
    };
    expect(resolve([first, next]).versionNumber).toBe(1);
    expect(resolve([first, next], until).versionNumber).toBe(2);
  });
  it("rejects overlapping published versions rather than choosing highest number", () => {
    const next = {
      ...version(),
      versionReference: id(8),
      versionNumber: 2,
      versionCode: "RECEIPT_V2",
    };
    expect(() => resolve([version(), next])).toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  });
  it.each(["brandReference", "storeReference", "templateReference"])(
    "rejects foreign %s even alongside a usable version",
    (field) => {
      expect(() => resolve([version(), { ...version(), [field]: id(20) }])).toThrow(
        "RECEIPT_TEMPLATE_UNAVAILABLE",
      );
    },
  );
  it("rejects missing, expired, wrong-locale and not-yet-published candidates", () => {
    expect(() => resolve([])).toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
    expect(() => resolve([version()], "2026-09-12T11:59:59.000Z")).toThrow(
      "RECEIPT_TEMPLATE_UNAVAILABLE",
    );
    expect(() =>
      resolve(
        [{ ...version(), effectiveUntil: "2026-09-12T13:00:00.000Z" }],
        "2026-09-12T13:00:00.000Z",
      ),
    ).toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
    expect(() => resolve([version()], at, "fr-CA")).toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  });
  it("rejects missing receipt fields, unknown render contract and unbounded candidate lists", () => {
    expect(() =>
      parseDigitalReceiptTemplateVersion({ ...version(), requiredFields: ["Total"] }),
    ).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
    expect(() =>
      parseDigitalReceiptTemplateVersion({ ...version(), renderEngineVersion: 2 }),
    ).toThrow("RECEIPT_TEMPLATE_INPUT_INVALID");
    expect(() => resolve(Array.from({ length: 101 }, version))).toThrow(
      "RECEIPT_TEMPLATE_UNAVAILABLE",
    );
  });
  it("rejects unknown fields, property accessors and sparse arrays without invoking accessors", () => {
    expect(() => parseDigitalReceiptTemplateVersion({ ...version(), html: "<script/>" })).toThrow(
      "RECEIPT_TEMPLATE_INPUT_INVALID",
    );
    let invoked = false;
    const input = version();
    Object.defineProperty(input, "locale", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "en-CA";
      },
    });
    expect(() => parseDigitalReceiptTemplateVersion(input)).toThrow(
      "RECEIPT_TEMPLATE_INPUT_INVALID",
    );
    expect(invoked).toBe(false);
    expect(() => resolve(new Array(1))).toThrow("RECEIPT_TEMPLATE_UNAVAILABLE");
  });
});
