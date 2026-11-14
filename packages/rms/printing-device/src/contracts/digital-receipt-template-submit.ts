import { parseDeviceReference, parseDeviceInstant } from "./device-management.js";
import { DigitalReceiptTemplateError } from "./digital-receipt-template.js";
import type { DigitalReceiptTemplateDraftActorScope } from "./digital-receipt-template-draft.js";
import {
  parseDigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateSubmission,
} from "./digital-receipt-template-submission.js";
interface Original extends DigitalReceiptTemplateDraftActorScope {
  readonly operationReference: string;
  readonly templateReference: string;
  readonly expectedVersionReference: string;
  readonly expectedRevision: number;
}
export interface DigitalReceiptTemplateSubmit extends Original {
  readonly profile: "DigitalReceiptTemplateSubmitV1";
  readonly purposeCode: "RECEIPT_TEMPLATE_REVIEW";
}
export interface DigitalReceiptTemplateSubmitResolve extends Original {
  readonly profile: "DigitalReceiptTemplateSubmitResolveV1";
  readonly purposeCode: "RECEIPT_TEMPLATE_REVIEW";
  readonly intentDigest: string;
}
export interface DigitalReceiptTemplateSubmitReceipt extends Original {
  readonly profile: "DigitalReceiptTemplateSubmitReceiptV1";
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly submission: DigitalReceiptTemplateSubmission | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
const invalid = (): never => {
  throw new DigitalReceiptTemplateError();
};
function protect<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
const originalKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "operationReference",
  "templateReference",
  "expectedVersionReference",
  "expectedRevision",
];
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
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
  return raw;
}
function original(raw: Record<string, unknown>): Original {
  const revision = raw.expectedRevision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > 2147483647
  )
    return invalid();
  return {
    tenantReference: parseDeviceReference(raw.tenantReference),
    brandReference: parseDeviceReference(raw.brandReference),
    storeReference: parseDeviceReference(raw.storeReference),
    actorReference: parseDeviceReference(raw.actorReference),
    operationReference: parseDeviceReference(raw.operationReference),
    templateReference: parseDeviceReference(raw.templateReference),
    expectedVersionReference: parseDeviceReference(raw.expectedVersionReference),
    expectedRevision: revision,
  };
}
function hash(value: unknown): string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : invalid();
}
function bounded<T>(parsed: T): T {
  if (new TextEncoder().encode(JSON.stringify(parsed)).length > 16384) return invalid();
  return Object.freeze(parsed);
}
export function parseDigitalReceiptTemplateSubmit(value: unknown): DigitalReceiptTemplateSubmit {
  return protect(() => {
    const raw = closed(value, ["profile", ...originalKeys, "purposeCode"]);
    if (
      raw.profile !== "DigitalReceiptTemplateSubmitV1" ||
      raw.purposeCode !== "RECEIPT_TEMPLATE_REVIEW"
    )
      return invalid();
    return bounded<DigitalReceiptTemplateSubmit>({
      profile: "DigitalReceiptTemplateSubmitV1",
      ...original(raw),
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    });
  });
}
export function parseDigitalReceiptTemplateSubmitResolve(
  value: unknown,
): DigitalReceiptTemplateSubmitResolve {
  return protect(() => {
    const raw = closed(value, ["profile", ...originalKeys, "purposeCode", "intentDigest"]);
    if (
      raw.profile !== "DigitalReceiptTemplateSubmitResolveV1" ||
      raw.purposeCode !== "RECEIPT_TEMPLATE_REVIEW"
    )
      return invalid();
    return bounded<DigitalReceiptTemplateSubmitResolve>({
      profile: "DigitalReceiptTemplateSubmitResolveV1",
      ...original(raw),
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      intentDigest: hash(raw.intentDigest),
    });
  });
}
/** Original receipt coherence only; it does not prove current approval or publication. */
export function parseDigitalReceiptTemplateSubmitReceipt(
  value: unknown,
): DigitalReceiptTemplateSubmitReceipt {
  return protect(() => {
    const raw = closed(value, [
        "profile",
        ...originalKeys,
        "intentDigest",
        "outcome",
        "submission",
        "auditReference",
        "occurredAt",
      ]),
      pins = original(raw),
      auditReference = parseDeviceReference(raw.auditReference),
      occurredAt = parseDeviceInstant(raw.occurredAt);
    if (
      raw.profile !== "DigitalReceiptTemplateSubmitReceiptV1" ||
      (raw.outcome !== "Committed" && raw.outcome !== "Abandoned")
    )
      return invalid();
    const submission =
      raw.submission === null ? null : parseDigitalReceiptTemplateSubmission(raw.submission);
    if (raw.outcome === "Abandoned" ? submission !== null : submission === null) return invalid();
    if (
      submission &&
      (submission.tenantReference !== pins.tenantReference ||
        submission.brandReference !== pins.brandReference ||
        submission.storeReference !== pins.storeReference ||
        submission.operationReference !== pins.operationReference ||
        submission.templateReference !== pins.templateReference ||
        submission.versionReference !== pins.expectedVersionReference ||
        submission.draftRevision !== pins.expectedRevision ||
        submission.submittedByReference !== pins.actorReference ||
        submission.auditReference !== auditReference ||
        submission.submittedAt !== occurredAt)
    )
      return invalid();
    return bounded<DigitalReceiptTemplateSubmitReceipt>({
      profile: "DigitalReceiptTemplateSubmitReceiptV1",
      ...pins,
      intentDigest: hash(raw.intentDigest),
      outcome: raw.outcome,
      submission,
      auditReference,
      occurredAt,
    });
  });
}
