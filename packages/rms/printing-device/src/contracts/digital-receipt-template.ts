import {
  parseDeviceReference,
  parseDeviceInstant,
  type DeviceReference,
} from "./device-management.js";

export const digitalReceiptRequiredFields = [
  "Issuer",
  "Store",
  "OrderNumber",
  "IssuedAt",
  "Items",
  "Subtotal",
  "Discount",
  "Fee",
  "Tax",
  "Tip",
  "Total",
  "PaymentStatus",
  "RefundedTotal",
] as const;
type ReceiptField = (typeof digitalReceiptRequiredFields)[number];
export interface DigitalReceiptTemplateVersion {
  readonly templateReference: DeviceReference;
  readonly versionReference: DeviceReference;
  readonly versionNumber: number;
  readonly versionCode: string;
  readonly brandReference: DeviceReference;
  readonly storeReference: DeviceReference;
  readonly locale: string;
  readonly dataContractVersion: 1;
  readonly renderEngineVersion: 1;
  readonly outputProfile: "AccessibleDigitalReceipt";
  readonly layoutDefinitionReference: DeviceReference;
  readonly complianceRuleReference: DeviceReference;
  readonly requiredFields: readonly ReceiptField[];
  readonly publicationReference: DeviceReference;
  readonly publishedAt: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
}
export class DigitalReceiptTemplateError extends Error {
  constructor(
    readonly code:
      | "RECEIPT_TEMPLATE_INPUT_INVALID"
      | "RECEIPT_TEMPLATE_UNAVAILABLE"
      | "RECEIPT_TEMPLATE_PERMISSION_DENIED"
      | "RECEIPT_TEMPLATE_CONFLICT" = "RECEIPT_TEMPLATE_INPUT_INVALID",
  ) {
    super(code);
    this.name = "DigitalReceiptTemplateError";
  }
}
const fail = (): never => {
  throw new DigitalReceiptTemplateError();
};
const unavailable = (): never => {
  throw new DigitalReceiptTemplateError("RECEIPT_TEMPLATE_UNAVAILABLE");
};
function exact(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail();
  const entries = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    return [key, descriptor.value as unknown] as const;
  });
  return Object.fromEntries(entries);
}
function array(value: unknown): readonly unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 100 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Object.freeze(
    Array.from({ length: value.length }, (_, i) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
      return descriptor.value as unknown;
    }),
  );
}
/** Published version facts only. Publisher must verify layout and compliance artifacts.
 * Parsing a publication reference is not proof of publication or legal compliance.
 */
export function parseDigitalReceiptTemplateVersion(value: unknown): DigitalReceiptTemplateVersion {
  try {
    const raw = exact(value, [
      "templateReference",
      "versionReference",
      "versionNumber",
      "versionCode",
      "brandReference",
      "storeReference",
      "locale",
      "dataContractVersion",
      "renderEngineVersion",
      "outputProfile",
      "layoutDefinitionReference",
      "complianceRuleReference",
      "requiredFields",
      "publicationReference",
      "publishedAt",
      "effectiveFrom",
      "effectiveUntil",
    ]);
    const fields = array(raw.requiredFields);
    if (
      fields.length !== digitalReceiptRequiredFields.length ||
      new Set(fields).size !== fields.length ||
      digitalReceiptRequiredFields.some((field) => !fields.includes(field))
    )
      return fail();
    if (
      typeof raw.versionNumber !== "number" ||
      !Number.isSafeInteger(raw.versionNumber) ||
      raw.versionNumber < 1 ||
      typeof raw.versionCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(raw.versionCode) ||
      typeof raw.locale !== "string" ||
      !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(raw.locale) ||
      raw.dataContractVersion !== 1 ||
      raw.renderEngineVersion !== 1 ||
      raw.outputProfile !== "AccessibleDigitalReceipt"
    )
      return fail();
    const publishedAt = parseDeviceInstant(raw.publishedAt);
    const effectiveFrom = parseDeviceInstant(raw.effectiveFrom);
    const effectiveUntil =
      raw.effectiveUntil === null ? null : parseDeviceInstant(raw.effectiveUntil);
    if (publishedAt > effectiveFrom || (effectiveUntil !== null && effectiveUntil <= effectiveFrom))
      return fail();
    return Object.freeze({
      templateReference: parseDeviceReference(raw.templateReference),
      versionReference: parseDeviceReference(raw.versionReference),
      versionNumber: raw.versionNumber,
      versionCode: raw.versionCode,
      brandReference: parseDeviceReference(raw.brandReference),
      storeReference: parseDeviceReference(raw.storeReference),
      locale: raw.locale,
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      layoutDefinitionReference: parseDeviceReference(raw.layoutDefinitionReference),
      complianceRuleReference: parseDeviceReference(raw.complianceRuleReference),
      requiredFields: Object.freeze(fields as ReceiptField[]),
      publicationReference: parseDeviceReference(raw.publicationReference),
      publishedAt,
      effectiveFrom,
      effectiveUntil,
    });
  } catch {
    return fail();
  }
}
/** Owner supplies complete published-version candidates for the exact configured template.
 * Missing, foreign-scope or ambiguous inputs never select a guessed latest version.
 */
export function resolveDigitalReceiptTemplate(input: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly templateReference: string;
  readonly locale: string;
  readonly observedAt: string;
  readonly versions: unknown;
}): DigitalReceiptTemplateVersion {
  try {
    const brand = parseDeviceReference(input.brandReference),
      store = parseDeviceReference(input.storeReference);
    const template = parseDeviceReference(input.templateReference),
      at = parseDeviceInstant(input.observedAt);
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(input.locale)) return unavailable();
    const versions = array(input.versions).map(parseDigitalReceiptTemplateVersion);
    if (
      versions.some(
        (version) =>
          version.brandReference !== brand ||
          version.storeReference !== store ||
          version.templateReference !== template,
      ) ||
      new Set(versions.map((version) => version.versionReference)).size !== versions.length ||
      new Set(versions.map((version) => version.versionNumber)).size !== versions.length ||
      new Set(versions.map((version) => version.versionCode)).size !== versions.length
    )
      return unavailable();
    const current = versions.filter(
      (version) =>
        version.locale === input.locale &&
        version.publishedAt <= at &&
        version.effectiveFrom <= at &&
        (version.effectiveUntil === null || at < version.effectiveUntil),
    );
    if (current.length !== 1 || !current[0]) return unavailable();
    return current[0];
  } catch {
    return unavailable();
  }
}
