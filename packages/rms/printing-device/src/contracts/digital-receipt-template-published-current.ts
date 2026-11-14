import { parseDeviceInstant, parseDeviceReference } from "./device-management.js";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateVersion,
  type DigitalReceiptTemplateVersion,
} from "./digital-receipt-template.js";
import type { DigitalReceiptTemplateDraftActorScope } from "./digital-receipt-template-draft.js";
export interface DigitalReceiptTemplatePublishedCurrent extends DigitalReceiptTemplateDraftActorScope {
  readonly profile: "DigitalReceiptTemplatePublishedCurrentV1";
  readonly templateReference: string;
  readonly locale: string;
  readonly currentVersion: DigitalReceiptTemplateVersion;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly professionalReviewStatus: "NotEvaluated";
  readonly legalConclusion: "NotEvaluated";
}
const invalid = (): never => {
  throw new DigitalReceiptTemplateError();
};
/** Structural current-version observation only. The actual owning pipeline must
 * acquire current publication; parsing does not prove professional/legal approval. */
export function parseDigitalReceiptTemplatePublishedCurrent(
  value: unknown,
): DigitalReceiptTemplatePublishedCurrent {
  try {
    const keys = [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "templateReference",
      "locale",
      "currentVersion",
      "observedAt",
      "validUntil",
      "professionalReviewStatus",
      "legalConclusion",
    ];
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return invalid();
    const raw: Record<string, unknown> = {};
    for (const key of keys) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d?.enumerable || !("value" in d)) return invalid();
      raw[key] = d.value;
    }
    if (
      raw.profile !== "DigitalReceiptTemplatePublishedCurrentV1" ||
      raw.professionalReviewStatus !== "NotEvaluated" ||
      raw.legalConclusion !== "NotEvaluated" ||
      typeof raw.locale !== "string" ||
      !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(raw.locale)
    )
      return invalid();
    const tenantReference = parseDeviceReference(raw.tenantReference),
      brandReference = parseDeviceReference(raw.brandReference),
      storeReference = parseDeviceReference(raw.storeReference),
      actorReference = parseDeviceReference(raw.actorReference),
      templateReference = parseDeviceReference(raw.templateReference),
      observedAt = parseDeviceInstant(raw.observedAt),
      validUntil = parseDeviceInstant(raw.validUntil),
      currentVersion = parseDigitalReceiptTemplateVersion(raw.currentVersion);
    if (
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
      String(currentVersion.brandReference) !== brandReference ||
      String(currentVersion.storeReference) !== storeReference ||
      String(currentVersion.templateReference) !== templateReference ||
      currentVersion.locale !== raw.locale ||
      currentVersion.publishedAt > observedAt ||
      currentVersion.effectiveFrom > observedAt ||
      (currentVersion.effectiveUntil !== null && currentVersion.effectiveUntil <= observedAt)
    )
      return invalid();
    const parsed: DigitalReceiptTemplatePublishedCurrent = {
      profile: "DigitalReceiptTemplatePublishedCurrentV1",
      tenantReference,
      brandReference,
      storeReference,
      actorReference,
      templateReference,
      locale: raw.locale,
      currentVersion,
      observedAt,
      validUntil,
      professionalReviewStatus: "NotEvaluated",
      legalConclusion: "NotEvaluated",
    };
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 16384) return invalid();
    return Object.freeze(parsed);
  } catch {
    return invalid();
  }
}
