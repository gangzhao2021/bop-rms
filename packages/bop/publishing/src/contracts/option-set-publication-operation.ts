import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingCode,
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
/** Original server-bound intent excludes clocks and newly allocated evidence/lifecycle IDs. */
export function parsePublishingOptionSetPublicationOperation(value: unknown) {
  const r = closed(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "selectedStoreReference",
    "actorReference",
    "reasonCode",
    "action",
    "operationReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "expectedReview",
    "expectedLifecycle",
  ]);
  if (
    r.profile !== "PublishingOptionSetPublicationOperationV1" ||
    (r.action !== "SubmitReview" && r.action !== "Approve" && r.action !== "Publish")
  )
    return fail();
  const review =
    r.expectedReview === null
      ? null
      : (() => {
          const v = closed(r.expectedReview, [
            "reviewOperationReference",
            "publishingReviewOperationReference",
            "recordDigest",
            "bindingDigest",
          ]);
          return Object.freeze({
            reviewOperationReference: parsePublishingReference(v.reviewOperationReference),
            publishingReviewOperationReference: parsePublishingReference(
              v.publishingReviewOperationReference,
            ),
            recordDigest: parsePublishingDigest(v.recordDigest),
            bindingDigest: parsePublishingDigest(v.bindingDigest),
          });
        })();
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
          if (v.state !== "Draft" && v.state !== "InReview" && v.state !== "Approved")
            return fail();
          return Object.freeze({
            lifecycleReference: parsePublishingReference(v.lifecycleReference),
            version: parsePublishingVersion(v.version),
            state: v.state as "Draft" | "InReview" | "Approved",
            latestMutationOperationReference: parsePublishingReference(
              v.latestMutationOperationReference,
            ),
          });
        })();
  if (r.action === "SubmitReview") {
    if (review !== null || (lifecycle !== null && lifecycle.state !== "Draft")) return fail();
  } else if (
    !review ||
    !lifecycle ||
    (r.action === "Approve" && lifecycle.state !== "InReview") ||
    (r.action === "Publish" && !["InReview", "Approved"].includes(lifecycle.state))
  )
    return fail();
  if (
    review &&
    lifecycle?.state === "InReview" &&
    review.publishingReviewOperationReference !== lifecycle.latestMutationOperationReference
  )
    return fail();
  return Object.freeze({
    profile: "PublishingOptionSetPublicationOperationV1" as const,
    tenantReference: parsePublishingReference(r.tenantReference),
    brandReference: parsePublishingReference(r.brandReference),
    selectedStoreReference: parsePublishingReference(r.selectedStoreReference),
    actorReference: parsePublishingReference(r.actorReference),
    reasonCode: parsePublishingCode(r.reasonCode),
    action: r.action as "SubmitReview" | "Approve" | "Publish",
    operationReference: parsePublishingReference(r.operationReference),
    optionSetReference: parsePublishingReference(r.optionSetReference),
    versionReference: parsePublishingReference(r.versionReference),
    expectedAggregateVersion: parsePublishingVersion(r.expectedAggregateVersion),
    sourceDigest: parsePublishingDigest(r.sourceDigest),
    contentDigest: parsePublishingDigest(r.contentDigest),
    configurationDigest: parsePublishingDigest(r.configurationDigest),
    expectedReview: review,
    expectedLifecycle: lifecycle,
  });
}
export type PublishingOptionSetPublicationOperation = ReturnType<
  typeof parsePublishingOptionSetPublicationOperation
>;
export function publishingOptionSetPublicationOperationDigest(
  value: PublishingOptionSetPublicationOperation,
) {
  return parsePublishingDigest(
    "sha256:" + sha256Hex(canonicalizeRfc8785(parsePublishingOptionSetPublicationOperation(value))),
  );
}
