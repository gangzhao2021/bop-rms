import type { PublishingLifecycleState } from "@bop/publishing";
import { parseDeviceReference, parseDeviceInstant } from "./device-management.js";
import { DigitalReceiptTemplateError } from "./digital-receipt-template.js";
import type { DigitalReceiptTemplateDraftActorScope } from "./digital-receipt-template-draft.js";
import {
  parseDigitalReceiptTemplateSubmission,
  type DigitalReceiptTemplateSubmission,
} from "./digital-receipt-template-submission.js";

type ReviewState = Extract<
  PublishingLifecycleState,
  "InReview" | "Approved" | "Published" | "Archived"
>;
export interface DigitalReceiptTemplateReviewCurrent extends DigitalReceiptTemplateDraftActorScope {
  readonly profile: "DigitalReceiptTemplateReviewCurrentV1";
  readonly templateReference: string;
  readonly currentDraft: Readonly<{
    versionReference: string;
    revision: number;
    contentDigest: string;
  }>;
  readonly submission: DigitalReceiptTemplateSubmission | null;
  readonly lifecycle: Readonly<{
    lifecycleReference: string;
    version: number;
    state: ReviewState;
    latestMutationOperationReference: string;
    changedAt: string;
    validationEvidenceReference: string;
    approvalEvidenceReference: string | null;
  }> | null;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly sourceQualification: "NotEvaluated";
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
  const raw: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return invalid();
    raw[key] = d.value;
  }
  return raw;
}
function positive(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= 2147483647
    ? value
    : invalid();
}
function digest(value: unknown): string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value : invalid();
}
/** Closed current observation joined to immutable submission history; not qualification. */
export function parseDigitalReceiptTemplateReviewCurrent(
  value: unknown,
): DigitalReceiptTemplateReviewCurrent {
  try {
    const r = closed(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "templateReference",
      "currentDraft",
      "submission",
      "lifecycle",
      "observedAt",
      "validUntil",
      "sourceQualification",
    ]);
    if (
      r.profile !== "DigitalReceiptTemplateReviewCurrentV1" ||
      r.sourceQualification !== "NotEvaluated"
    )
      return invalid();
    const tenantReference = parseDeviceReference(r.tenantReference),
      brandReference = parseDeviceReference(r.brandReference),
      storeReference = parseDeviceReference(r.storeReference),
      actorReference = parseDeviceReference(r.actorReference),
      templateReference = parseDeviceReference(r.templateReference);
    const observedAt = parseDeviceInstant(r.observedAt),
      validUntil = parseDeviceInstant(r.validUntil);
    if (validUntil <= observedAt || Date.parse(validUntil) - Date.parse(observedAt) > 5000)
      return invalid();
    const d = closed(r.currentDraft, ["versionReference", "revision", "contentDigest"]);
    const currentDraft = Object.freeze({
      versionReference: parseDeviceReference(d.versionReference),
      revision: positive(d.revision),
      contentDigest: digest(d.contentDigest),
    });
    const submission =
      r.submission === null ? null : parseDigitalReceiptTemplateSubmission(r.submission);
    let lifecycle: DigitalReceiptTemplateReviewCurrent["lifecycle"] = null;
    if ((submission === null) !== (r.lifecycle === null)) return invalid();
    if (submission !== null) {
      const l = closed(r.lifecycle, [
        "lifecycleReference",
        "version",
        "state",
        "latestMutationOperationReference",
        "changedAt",
        "validationEvidenceReference",
        "approvalEvidenceReference",
      ]);
      if (
        l.state !== "InReview" &&
        l.state !== "Approved" &&
        l.state !== "Published" &&
        l.state !== "Archived"
      )
        return invalid();
      lifecycle = Object.freeze({
        lifecycleReference: parseDeviceReference(l.lifecycleReference),
        version: positive(l.version),
        state: l.state,
        latestMutationOperationReference: parseDeviceReference(l.latestMutationOperationReference),
        changedAt: parseDeviceInstant(l.changedAt),
        validationEvidenceReference: parseDeviceReference(l.validationEvidenceReference),
        approvalEvidenceReference:
          l.approvalEvidenceReference === null
            ? null
            : parseDeviceReference(l.approvalEvidenceReference),
      });
      if (
        submission.tenantReference !== tenantReference ||
        submission.brandReference !== brandReference ||
        submission.storeReference !== storeReference ||
        submission.templateReference !== templateReference ||
        submission.submittedAt > observedAt ||
        lifecycle.lifecycleReference !== submission.reviewLifecycleReference ||
        lifecycle.version < submission.reviewVersion ||
        lifecycle.validationEvidenceReference !== submission.validationEvidenceReference ||
        lifecycle.changedAt < submission.submittedAt ||
        lifecycle.changedAt > observedAt
      )
        return invalid();
      if (
        lifecycle.state === "InReview" &&
        (lifecycle.version !== submission.reviewVersion ||
          lifecycle.latestMutationOperationReference !== submission.operationReference ||
          lifecycle.changedAt !== submission.submittedAt ||
          lifecycle.approvalEvidenceReference !== null)
      )
        return invalid();
      if (lifecycle.state !== "InReview" && lifecycle.version <= submission.reviewVersion)
        return invalid();
      if (
        currentDraft.revision < submission.draftRevision ||
        (currentDraft.versionReference === submission.versionReference &&
          (currentDraft.revision !== submission.draftRevision ||
            currentDraft.contentDigest !== submission.contentDigest)) ||
        (currentDraft.revision === submission.draftRevision &&
          currentDraft.versionReference !== submission.versionReference)
      )
        return invalid();
    }
    const parsed: DigitalReceiptTemplateReviewCurrent = {
      profile: "DigitalReceiptTemplateReviewCurrentV1",
      tenantReference,
      brandReference,
      storeReference,
      actorReference,
      templateReference,
      currentDraft,
      submission,
      lifecycle,
      observedAt,
      validUntil,
      sourceQualification: "NotEvaluated",
    };
    if (new TextEncoder().encode(JSON.stringify(parsed)).length > 16384) return invalid();
    return Object.freeze(parsed);
  } catch {
    return invalid();
  }
}
