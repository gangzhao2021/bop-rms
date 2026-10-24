import { parseDeviceReference, parseDeviceInstant } from "./device-management.js";
import { DigitalReceiptTemplateError } from "./digital-receipt-template.js";
import {
  parseDigitalReceiptTemplateDraft,
  type DigitalReceiptTemplateDraftScope,
} from "./digital-receipt-template-draft.js";
import type { DigitalReceiptTemplateContent } from "./digital-receipt-template-content.js";

/** Immutable submission provenance; parsing does not acquire current authority or qualification. */
export interface DigitalReceiptTemplateSubmission extends DigitalReceiptTemplateDraftScope {
  readonly profile: "DigitalReceiptTemplateSubmissionV1";
  readonly templateReference: string;
  readonly familyReference: string;
  readonly versionReference: string;
  readonly draftRevision: number;
  readonly contentDigest: string;
  readonly authoredByReference: string;
  readonly submittedByReference: string;
  readonly operationReference: string;
  readonly reviewLifecycleReference: string;
  readonly reviewVersion: number;
  readonly validationEvidenceReference: string;
  readonly checkedAt: string;
  readonly validationValidUntil: string;
  readonly submittedAt: string;
  readonly auditReference: string;
  readonly dataClassification: "Internal";
}
export interface DigitalReceiptTemplateAuthoredContent {
  readonly profile: "DigitalReceiptTemplateAuthoredContentV2";
  readonly content: DigitalReceiptTemplateContent;
  readonly authoredByReference: string;
  readonly submittedByReference: string;
  readonly familyReference: string;
  readonly reviewLifecycleReference: string;
  readonly reviewVersion: number;
}
const keys = [
  "profile",
  "tenantReference",
  "brandReference",
  "storeReference",
  "templateReference",
  "familyReference",
  "versionReference",
  "draftRevision",
  "contentDigest",
  "authoredByReference",
  "submittedByReference",
  "operationReference",
  "reviewLifecycleReference",
  "reviewVersion",
  "validationEvidenceReference",
  "checkedAt",
  "validationValidUntil",
  "submittedAt",
  "auditReference",
  "dataClassification",
] as const;
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
function revision(value: unknown, minimum: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > 2147483647
  )
    return invalid();
  return value;
}
export function parseDigitalReceiptTemplateSubmission(
  value: unknown,
): DigitalReceiptTemplateSubmission {
  return protect(() => {
    if (
      !value ||
      typeof value !== "object" ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length
    )
      return invalid();
    const raw: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return invalid();
      // Every field is scalar; reject objects before serialization or coercion.
      if (typeof descriptor.value !== "string" && typeof descriptor.value !== "number")
        return invalid();
      raw[key] = descriptor.value;
    }
    if (
      raw.profile !== "DigitalReceiptTemplateSubmissionV1" ||
      raw.dataClassification !== "Internal" ||
      typeof raw.contentDigest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/u.test(raw.contentDigest)
    )
      return invalid();
    const checkedAt = parseDeviceInstant(raw.checkedAt),
      submittedAt = parseDeviceInstant(raw.submittedAt),
      validationValidUntil = parseDeviceInstant(raw.validationValidUntil);
    if (checkedAt > submittedAt || submittedAt >= validationValidUntil) return invalid();
    const parsed: DigitalReceiptTemplateSubmission = {
      profile: "DigitalReceiptTemplateSubmissionV1",
      tenantReference: parseDeviceReference(raw.tenantReference),
      brandReference: parseDeviceReference(raw.brandReference),
      storeReference: parseDeviceReference(raw.storeReference),
      templateReference: parseDeviceReference(raw.templateReference),
      familyReference: parseDeviceReference(raw.familyReference),
      versionReference: parseDeviceReference(raw.versionReference),
      draftRevision: revision(raw.draftRevision, 1),
      contentDigest: raw.contentDigest,
      authoredByReference: parseDeviceReference(raw.authoredByReference),
      submittedByReference: parseDeviceReference(raw.submittedByReference),
      operationReference: parseDeviceReference(raw.operationReference),
      reviewLifecycleReference: parseDeviceReference(raw.reviewLifecycleReference),
      reviewVersion: revision(raw.reviewVersion, 2),
      validationEvidenceReference: parseDeviceReference(raw.validationEvidenceReference),
      checkedAt,
      validationValidUntil,
      submittedAt,
      auditReference: parseDeviceReference(raw.auditReference),
      dataClassification: "Internal",
    };
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 16384) return invalid();
    return Object.freeze(parsed);
  });
}
/** Structural join of two recorded owning facts, never a current source or approval proof. */
export function createDigitalReceiptTemplateAuthoredContent(
  submission: unknown,
  draftSnapshot: unknown,
): DigitalReceiptTemplateAuthoredContent {
  return protect(() => {
    const record = parseDigitalReceiptTemplateSubmission(submission),
      draft = parseDigitalReceiptTemplateDraft(draftSnapshot);
    if (
      record.tenantReference !== draft.content.tenantReference ||
      record.brandReference !== draft.content.brandReference ||
      record.storeReference !== draft.content.storeReference ||
      record.templateReference !== draft.content.templateReference ||
      record.versionReference !== draft.content.versionReference ||
      record.familyReference !== draft.familyReference ||
      record.draftRevision !== draft.revision ||
      record.contentDigest !== draft.contentDigest ||
      record.authoredByReference !== draft.authoredByReference ||
      draft.updatedAt > record.submittedAt
    )
      return invalid();
    return Object.freeze({
      profile: "DigitalReceiptTemplateAuthoredContentV2",
      content: draft.content,
      authoredByReference: record.authoredByReference,
      submittedByReference: record.submittedByReference,
      familyReference: record.familyReference,
      reviewLifecycleReference: record.reviewLifecycleReference,
      reviewVersion: record.reviewVersion,
    });
  });
}
