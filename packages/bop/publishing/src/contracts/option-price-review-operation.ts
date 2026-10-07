import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingCode,
  parsePublishingInstant,
} from "./publishing.js";
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const keys = Reflect.ownKeys(value),
    descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  return Object.fromEntries(
    fields.map((k) => {
      const d = descriptors[k];
      if (!d?.enumerable || !("value" in d)) return fail();
      return [k, d.value];
    }),
  );
}
/** Stable business intent; generated mutation clocks and evidence IDs are owner-only. */
export function parsePublishingOptionPriceReviewOperation(value: unknown) {
  const r = closed(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "selectedStoreReference",
    "actorReference",
    "reasonCode",
    "action",
    "operationReference",
    "ruleReference",
    "draftVersionReference",
    "draftSnapshotDigest",
    "expectedAggregateVersion",
    "validationValidUntil",
    "approvalValidUntil",
    "expectedLifecycle",
  ]);
  if (
    r.profile !== "PublishingOptionPriceReviewOperationV1" ||
    r.reasonCode !== "AUTHORIZED_OPERATION" ||
    (r.action !== "SubmitReview" && r.action !== "Approve")
  )
    return fail();
  const lifecycle =
    r.expectedLifecycle === null
      ? null
      : (() => {
          const v = closed(r.expectedLifecycle, [
            "lifecycleReference",
            "version",
            "state",
            "latestMutationOperationReference",
          ]);
          if (v.state !== "Draft" && v.state !== "InReview") return fail();
          return Object.freeze({
            lifecycleReference: parsePublishingReference(v.lifecycleReference),
            version: parsePublishingVersion(v.version),
            state: v.state as "Draft" | "InReview",
            latestMutationOperationReference: parsePublishingReference(
              v.latestMutationOperationReference,
            ),
          });
        })();
  const validationValidUntil = parsePublishingInstant(r.validationValidUntil),
    approvalValidUntil =
      r.approvalValidUntil === null ? null : parsePublishingInstant(r.approvalValidUntil);
  if (
    r.action === "SubmitReview"
      ? approvalValidUntil !== null || (lifecycle !== null && lifecycle.state !== "Draft")
      : approvalValidUntil === null ||
        lifecycle?.state !== "InReview" ||
        approvalValidUntil > validationValidUntil
  )
    return fail();
  return Object.freeze({
    profile: "PublishingOptionPriceReviewOperationV1" as const,
    tenantReference: parsePublishingReference(r.tenantReference),
    brandReference: parsePublishingReference(r.brandReference),
    selectedStoreReference: parsePublishingReference(r.selectedStoreReference),
    actorReference: parsePublishingReference(r.actorReference),
    reasonCode: parsePublishingCode(r.reasonCode),
    action: r.action as "SubmitReview" | "Approve",
    operationReference: parsePublishingReference(r.operationReference),
    ruleReference: parsePublishingReference(r.ruleReference),
    draftVersionReference: parsePublishingReference(r.draftVersionReference),
    draftSnapshotDigest: parsePublishingDigest(r.draftSnapshotDigest),
    expectedAggregateVersion: parsePublishingVersion(r.expectedAggregateVersion),
    validationValidUntil,
    approvalValidUntil,
    expectedLifecycle: lifecycle,
  });
}
export type PublishingOptionPriceReviewOperation = ReturnType<
  typeof parsePublishingOptionPriceReviewOperation
>;
export function publishingOptionPriceReviewOperationDigest(
  value: PublishingOptionPriceReviewOperation,
) {
  return parsePublishingDigest(
    "sha256:" + sha256Hex(canonicalizeRfc8785(parsePublishingOptionPriceReviewOperation(value))),
  );
}
