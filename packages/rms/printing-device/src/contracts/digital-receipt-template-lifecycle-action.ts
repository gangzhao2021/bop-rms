import { parseDeviceInstant, parseDeviceReference } from "./device-management.js";
import {
  DigitalReceiptTemplateError,
  parseDigitalReceiptTemplateVersion,
  type DigitalReceiptTemplateVersion,
} from "./digital-receipt-template.js";
import type { DigitalReceiptTemplateDraftActorScope } from "./digital-receipt-template-draft.js";
export const digitalReceiptTemplateLifecycleActionRequiredFields = Object.freeze([
  "templateReference",
  "expectedVersionReference",
  "expectedRevision",
  "reviewLifecycleReference",
  "expectedReviewVersion",
  "expectedReviewOperationReference",
  "action",
] as const);
interface Original extends DigitalReceiptTemplateDraftActorScope {
  readonly action: "Approve" | "Publish";
  readonly operationReference: string;
  readonly templateReference: string;
  readonly expectedVersionReference: string;
  readonly expectedRevision: number;
  readonly reviewLifecycleReference: string;
  readonly expectedReviewVersion: number;
  readonly expectedReviewOperationReference: string;
}
export interface DigitalReceiptTemplateLifecycleAction extends Original {
  readonly profile: "DigitalReceiptTemplateLifecycleActionV1";
  readonly purposeCode: "RECEIPT_TEMPLATE_REVIEW";
}
export interface DigitalReceiptTemplateLifecycleResolve extends Original {
  readonly profile: "DigitalReceiptTemplateLifecycleResolveV1";
  readonly purposeCode: "RECEIPT_TEMPLATE_REVIEW";
  readonly intentDigest: string;
}
export interface DigitalReceiptTemplateLifecycleResult {
  readonly lifecycleReference: string;
  readonly lifecycleVersion: number;
  readonly state: "Approved" | "Published";
  readonly mutationOperationReference: string;
  readonly changedAt: string;
  readonly approvalEvidenceReference: string;
  readonly approvedByReference: string;
  readonly approvedAt: string;
  readonly approvalValidUntil: string;
  readonly publishedVersion: DigitalReceiptTemplateVersion | null;
}
export interface DigitalReceiptTemplateLifecycleReceipt extends Original {
  readonly profile: "DigitalReceiptTemplateLifecycleReceiptV1";
  readonly intentDigest: string;
  readonly outcome: "Committed" | "Abandoned";
  readonly result: DigitalReceiptTemplateLifecycleResult | null;
  readonly auditReference: string;
  readonly occurredAt: string;
}
const invalid = (): never => {
  throw new DigitalReceiptTemplateError();
};
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    result[key] = d.value;
  }
  return result;
}
const keys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "action",
  "operationReference",
  "templateReference",
  "expectedVersionReference",
  "expectedRevision",
  "reviewLifecycleReference",
  "expectedReviewVersion",
  "expectedReviewOperationReference",
] as const;
function revision(value: unknown, minimum = 1): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= 2147483647
    ? value
    : invalid();
}
function hash(value: unknown): string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : invalid();
}
function original(r: Record<string, unknown>): Original {
  if (r.action !== "Approve" && r.action !== "Publish") return invalid();
  const operationReference = parseDeviceReference(r.operationReference),
    expectedReviewOperationReference = parseDeviceReference(r.expectedReviewOperationReference),
    expectedReviewVersion = revision(r.expectedReviewVersion, 2);
  if (
    operationReference === expectedReviewOperationReference ||
    expectedReviewVersion === 2147483647
  )
    return invalid();
  return {
    tenantReference: parseDeviceReference(r.tenantReference),
    brandReference: parseDeviceReference(r.brandReference),
    storeReference: parseDeviceReference(r.storeReference),
    actorReference: parseDeviceReference(r.actorReference),
    action: r.action,
    operationReference,
    templateReference: parseDeviceReference(r.templateReference),
    expectedVersionReference: parseDeviceReference(r.expectedVersionReference),
    expectedRevision: revision(r.expectedRevision),
    reviewLifecycleReference: parseDeviceReference(r.reviewLifecycleReference),
    expectedReviewVersion,
    expectedReviewOperationReference,
  };
}
function protect<T>(work: () => T): T {
  try {
    return work();
  } catch {
    return invalid();
  }
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 16384) return invalid();
  return Object.freeze(value);
}
export function parseDigitalReceiptTemplateLifecycleAction(
  value: unknown,
): DigitalReceiptTemplateLifecycleAction {
  return protect(() => {
    const r = closed(value, ["profile", ...keys, "purposeCode"]);
    if (
      r.profile !== "DigitalReceiptTemplateLifecycleActionV1" ||
      r.purposeCode !== "RECEIPT_TEMPLATE_REVIEW"
    )
      return invalid();
    return bounded<DigitalReceiptTemplateLifecycleAction>({
      profile: "DigitalReceiptTemplateLifecycleActionV1",
      ...original(r),
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
    });
  });
}
export function parseDigitalReceiptTemplateLifecycleResolve(
  value: unknown,
): DigitalReceiptTemplateLifecycleResolve {
  return protect(() => {
    const r = closed(value, ["profile", ...keys, "purposeCode", "intentDigest"]);
    if (
      r.profile !== "DigitalReceiptTemplateLifecycleResolveV1" ||
      r.purposeCode !== "RECEIPT_TEMPLATE_REVIEW"
    )
      return invalid();
    return bounded<DigitalReceiptTemplateLifecycleResolve>({
      profile: "DigitalReceiptTemplateLifecycleResolveV1",
      ...original(r),
      purposeCode: "RECEIPT_TEMPLATE_REVIEW",
      intentDigest: hash(r.intentDigest),
    });
  });
}
/** Immutable original action receipt. Parsing is not current publication or legal qualification. */
export function parseDigitalReceiptTemplateLifecycleReceipt(
  value: unknown,
): DigitalReceiptTemplateLifecycleReceipt {
  return protect(() => {
    const r = closed(value, [
        "profile",
        ...keys,
        "intentDigest",
        "outcome",
        "result",
        "auditReference",
        "occurredAt",
      ]),
      pins = original(r),
      occurredAt = parseDeviceInstant(r.occurredAt);
    if (
      r.profile !== "DigitalReceiptTemplateLifecycleReceiptV1" ||
      (r.outcome !== "Committed" && r.outcome !== "Abandoned")
    )
      return invalid();
    let result: DigitalReceiptTemplateLifecycleResult | null = null;
    if (r.outcome === "Abandoned") {
      if (r.result !== null) return invalid();
    } else {
      const p = closed(r.result, [
        "lifecycleReference",
        "lifecycleVersion",
        "state",
        "mutationOperationReference",
        "changedAt",
        "approvalEvidenceReference",
        "approvedByReference",
        "approvedAt",
        "approvalValidUntil",
        "publishedVersion",
      ]);
      if (p.state !== "Approved" && p.state !== "Published") return invalid();
      result = Object.freeze({
        lifecycleReference: parseDeviceReference(p.lifecycleReference),
        lifecycleVersion: revision(p.lifecycleVersion),
        state: p.state,
        mutationOperationReference: parseDeviceReference(p.mutationOperationReference),
        changedAt: parseDeviceInstant(p.changedAt),
        approvalEvidenceReference: parseDeviceReference(p.approvalEvidenceReference),
        approvedByReference: parseDeviceReference(p.approvedByReference),
        approvedAt: parseDeviceInstant(p.approvedAt),
        approvalValidUntil: parseDeviceInstant(p.approvalValidUntil),
        publishedVersion:
          p.publishedVersion === null
            ? null
            : parseDigitalReceiptTemplateVersion(p.publishedVersion),
      });
      if (
        result.lifecycleReference !== pins.reviewLifecycleReference ||
        result.lifecycleVersion !== pins.expectedReviewVersion + 1 ||
        result.mutationOperationReference !== pins.operationReference ||
        result.changedAt !== occurredAt ||
        result.approvedAt > result.changedAt ||
        result.changedAt >= result.approvalValidUntil
      )
        return invalid();
      if (pins.action === "Approve") {
        if (
          result.state !== "Approved" ||
          result.publishedVersion !== null ||
          result.approvedByReference !== pins.actorReference ||
          result.approvedAt !== occurredAt
        )
          return invalid();
      } else {
        const version = result.publishedVersion;
        if (
          result.state !== "Published" ||
          version === null ||
          String(version.brandReference) !== pins.brandReference ||
          String(version.storeReference) !== pins.storeReference ||
          String(version.templateReference) !== pins.templateReference ||
          String(version.versionReference) !== pins.expectedVersionReference ||
          version.publishedAt !== occurredAt
        )
          return invalid();
      }
    }
    return bounded<DigitalReceiptTemplateLifecycleReceipt>({
      profile: "DigitalReceiptTemplateLifecycleReceiptV1",
      ...pins,
      intentDigest: hash(r.intentDigest),
      outcome: r.outcome,
      result,
      auditReference: parseDeviceReference(r.auditReference),
      occurredAt,
    });
  });
}
