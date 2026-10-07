import {
  parseDeviceInstant,
  parseDeviceReference,
  type DeviceReference,
} from "./device-management.js";
import {
  DigitalReceiptTemplateError,
  digitalReceiptRequiredFields,
  parseDigitalReceiptTemplateVersion,
  type DigitalReceiptTemplateVersion,
} from "./digital-receipt-template.js";

export interface DigitalReceiptTemplateContent {
  readonly profile: "DigitalReceiptTemplateContentV2";
  readonly tenantReference: DeviceReference;
  readonly brandReference: DeviceReference;
  readonly storeReference: DeviceReference;
  readonly templateReference: DeviceReference;
  readonly versionReference: DeviceReference;
  readonly versionNumber: number;
  readonly versionCode: string;
  readonly locale: string;
  readonly dataContractVersion: 1;
  readonly renderEngineVersion: 1;
  readonly outputProfile: "AccessibleDigitalReceipt";
  readonly layoutDefinitionReference: DeviceReference;
  readonly complianceRuleReference: DeviceReference;
  readonly requiredFields: readonly (typeof digitalReceiptRequiredFields)[number][];
  readonly activation:
    Readonly<{ mode: "Immediate" }> | Readonly<{ mode: "Scheduled"; effectiveFrom: string }>;
  readonly effectiveUntil: string | null;
  readonly dataClassification: "Internal";
}
const invalid = (): never => {
  throw new DigitalReceiptTemplateError();
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const own = Reflect.ownKeys(value);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return invalid();
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
      return [key, descriptor.value as unknown];
    }),
  );
}
function fields(value: unknown): DigitalReceiptTemplateContent["requiredFields"] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== digitalReceiptRequiredFields.length ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid();
  const result = Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
    const field: unknown = descriptor.value;
    const known = digitalReceiptRequiredFields.find((candidate) => candidate === field);
    return known ?? invalid();
  });
  if (new Set(result).size !== digitalReceiptRequiredFields.length) return invalid();
  return Object.freeze(result);
}
/** Authored content only. Neither artifact references nor parsing certify acquisition,
 * professional compliance, approval, publication or current source authority. */
export function parseDigitalReceiptTemplateContent(value: unknown): DigitalReceiptTemplateContent {
  try {
    const r = closed(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "templateReference",
      "versionReference",
      "versionNumber",
      "versionCode",
      "locale",
      "dataContractVersion",
      "renderEngineVersion",
      "outputProfile",
      "layoutDefinitionReference",
      "complianceRuleReference",
      "requiredFields",
      "activation",
      "effectiveUntil",
      "dataClassification",
    ]);
    if (
      r.profile !== "DigitalReceiptTemplateContentV2" ||
      r.dataContractVersion !== 1 ||
      r.renderEngineVersion !== 1 ||
      r.outputProfile !== "AccessibleDigitalReceipt" ||
      r.dataClassification !== "Internal" ||
      typeof r.versionNumber !== "number" ||
      !Number.isSafeInteger(r.versionNumber) ||
      r.versionNumber < 1 ||
      typeof r.versionCode !== "string" ||
      !/^[A-Z][A-Z0-9_]{0,63}$/u.test(r.versionCode) ||
      typeof r.locale !== "string" ||
      !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(r.locale)
    )
      return invalid();
    const activationValue = r.activation;
    if (activationValue === null || typeof activationValue !== "object") return invalid();
    const modeDescriptor = Object.getOwnPropertyDescriptor(activationValue, "mode");
    if (!modeDescriptor?.enumerable || !("value" in modeDescriptor)) return invalid();
    let activation: DigitalReceiptTemplateContent["activation"];
    if (modeDescriptor.value === "Immediate") {
      closed(activationValue, ["mode"]);
      activation = Object.freeze({ mode: "Immediate" });
    } else if (modeDescriptor.value === "Scheduled") {
      const scheduled = closed(activationValue, ["mode", "effectiveFrom"]);
      activation = Object.freeze({
        mode: "Scheduled",
        effectiveFrom: parseDeviceInstant(scheduled.effectiveFrom),
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
      profile: "DigitalReceiptTemplateContentV2",
      tenantReference: parseDeviceReference(r.tenantReference),
      brandReference: parseDeviceReference(r.brandReference),
      storeReference: parseDeviceReference(r.storeReference),
      templateReference: parseDeviceReference(r.templateReference),
      versionReference: parseDeviceReference(r.versionReference),
      versionNumber: r.versionNumber,
      versionCode: r.versionCode,
      locale: r.locale,
      dataContractVersion: 1,
      renderEngineVersion: 1,
      outputProfile: "AccessibleDigitalReceipt",
      layoutDefinitionReference: parseDeviceReference(r.layoutDefinitionReference),
      complianceRuleReference: parseDeviceReference(r.complianceRuleReference),
      requiredFields: fields(r.requiredFields),
      activation,
      effectiveUntil,
      dataClassification: "Internal",
    });
  } catch {
    return invalid();
  }
}
/** Final publication metadata must come from the actual held Publishing mutation.
 * This pure materializer validates coherence; it does not authenticate that source. */
export function materializeDigitalReceiptTemplateContent(input: {
  readonly content: unknown;
  readonly publicationReference: unknown;
  readonly publishedAt: unknown;
}): DigitalReceiptTemplateVersion {
  try {
    const r = closed(input, ["content", "publicationReference", "publishedAt"]);
    const content = parseDigitalReceiptTemplateContent(r.content);
    const publicationReference = parseDeviceReference(r.publicationReference),
      publishedAt = parseDeviceInstant(r.publishedAt);
    const effectiveFrom =
      content.activation.mode === "Immediate" ? publishedAt : content.activation.effectiveFrom;
    if (
      effectiveFrom < publishedAt ||
      (content.effectiveUntil !== null && content.effectiveUntil <= effectiveFrom)
    )
      return invalid();
    return parseDigitalReceiptTemplateVersion({
      templateReference: content.templateReference,
      versionReference: content.versionReference,
      versionNumber: content.versionNumber,
      versionCode: content.versionCode,
      brandReference: content.brandReference,
      storeReference: content.storeReference,
      locale: content.locale,
      dataContractVersion: content.dataContractVersion,
      renderEngineVersion: content.renderEngineVersion,
      outputProfile: content.outputProfile,
      layoutDefinitionReference: content.layoutDefinitionReference,
      complianceRuleReference: content.complianceRuleReference,
      requiredFields: [...content.requiredFields],
      publicationReference,
      publishedAt,
      effectiveFrom,
      effectiveUntil: content.effectiveUntil,
    });
  } catch {
    return invalid();
  }
}
/** Exact authored-content/envelope coherence, without a claim of Publishing proof. */
export function assertDigitalReceiptTemplateContentEnvelope(
  content: unknown,
  value: unknown,
): DigitalReceiptTemplateVersion {
  try {
    const envelope = parseDigitalReceiptTemplateVersion(value);
    const expected = materializeDigitalReceiptTemplateContent({
      content,
      publicationReference: envelope.publicationReference,
      publishedAt: envelope.publishedAt,
    });
    for (const key of Object.keys(expected) as (keyof DigitalReceiptTemplateVersion)[]) {
      if (key === "requiredFields") {
        if (
          expected.requiredFields.some((field, index) => envelope.requiredFields[index] !== field)
        )
          return invalid();
      } else if (expected[key] !== envelope[key]) return invalid();
    }
    return envelope;
  } catch {
    return invalid();
  }
}
