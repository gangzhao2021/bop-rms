import {
  parseDeviceReference,
  parseDeviceInstant,
  type DeviceReference,
} from "./device-management.js";
import {
  DigitalReceiptTemplateError,
  digitalReceiptRequiredFields,
} from "./digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateContent,
  type DigitalReceiptTemplateContent,
} from "./digital-receipt-template-content.js";
export interface DigitalReceiptTemplateDraftFields {
  readonly locale: string;
  readonly layoutDefinitionReference: DeviceReference;
  readonly complianceRuleReference: DeviceReference;
  readonly activation: DigitalReceiptTemplateContent["activation"];
  readonly effectiveUntil: string | null;
}
const invalid = (): never => {
  throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some((k) => typeof k !== "string" || !keys.includes(k)))
    return invalid();
  return Object.fromEntries(
    keys.map((k) => {
      const d = Object.getOwnPropertyDescriptor(value, k);
      if (!d?.enumerable || !("value" in d)) return invalid();
      return [k, d.value as unknown];
    }),
  );
}
/** Editable fields only; references are not artifact acquisition or legal proof. */
export function parseDigitalReceiptTemplateDraftFields(
  value: unknown,
): DigitalReceiptTemplateDraftFields {
  try {
    const r = closed(value, [
      "locale",
      "layoutDefinitionReference",
      "complianceRuleReference",
      "activation",
      "effectiveUntil",
    ]);
    if (typeof r.locale !== "string" || !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(r.locale))
      return invalid();
    if (r.activation === null || typeof r.activation !== "object") return invalid();
    const mode = Object.getOwnPropertyDescriptor(r.activation, "mode");
    if (!mode?.enumerable || !("value" in mode)) return invalid();
    let activation: DigitalReceiptTemplateDraftFields["activation"];
    if (mode.value === "Immediate") {
      closed(r.activation, ["mode"]);
      activation = Object.freeze({ mode: "Immediate" });
    } else if (mode.value === "Scheduled") {
      const a = closed(r.activation, ["mode", "effectiveFrom"]);
      activation = Object.freeze({
        mode: "Scheduled",
        effectiveFrom: parseDeviceInstant(a.effectiveFrom),
      });
    } else return invalid();
    const effectiveUntil = r.effectiveUntil === null ? null : parseDeviceInstant(r.effectiveUntil);
    if (
      activation.mode === "Scheduled" &&
      effectiveUntil !== null &&
      effectiveUntil <= activation.effectiveFrom
    )
      return invalid();
    return Object.freeze({
      locale: r.locale,
      layoutDefinitionReference: parseDeviceReference(r.layoutDefinitionReference),
      complianceRuleReference: parseDeviceReference(r.complianceRuleReference),
      activation,
      effectiveUntil,
    });
  } catch {
    return invalid();
  }
}
/** Server pins must be actual owning metadata. This pure builder cannot allocate,
 * approve or publish; Draft revisions may share the next publication number. */
export function createDigitalReceiptTemplateDraftContent(input: {
  readonly tenantReference: unknown;
  readonly brandReference: unknown;
  readonly storeReference: unknown;
  readonly templateReference: unknown;
  readonly versionReference: unknown;
  readonly versionNumber: unknown;
  readonly fields: unknown;
}): DigitalReceiptTemplateContent {
  try {
    const r = closed(input, [
        "tenantReference",
        "brandReference",
        "storeReference",
        "templateReference",
        "versionReference",
        "versionNumber",
        "fields",
      ]),
      fields = parseDigitalReceiptTemplateDraftFields(r.fields);
    if (
      typeof r.versionNumber !== "number" ||
      !Number.isSafeInteger(r.versionNumber) ||
      r.versionNumber < 1
    )
      return invalid();
    return parseDigitalReceiptTemplateContent({
      profile: "DigitalReceiptTemplateContentV2",
      tenantReference: parseDeviceReference(r.tenantReference),
      brandReference: parseDeviceReference(r.brandReference),
      storeReference: parseDeviceReference(r.storeReference),
      templateReference: parseDeviceReference(r.templateReference),
      versionReference: parseDeviceReference(r.versionReference),
      versionNumber: r.versionNumber,
      versionCode: `RECEIPT_${r.versionNumber}`,
      ...fields,
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      requiredFields: [...digitalReceiptRequiredFields],
      dataClassification: "Internal",
    });
  } catch {
    return invalid();
  }
}
