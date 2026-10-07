import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPublishingReleaseRecord,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parseReleaseSequence,
} from "@bop/publishing";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogCode,
} from "./product.js";
import { copyCategoryPersistenceValue } from "./category-persistence.js";
import { createCatalogOptionSetContentReviewBinding } from "./option-set-review-binding.js";
import { parseCatalogOptionSetEditorContent } from "./option-set-editor-content.js";

export const optionSetReviewRecordMaximumBytes = 2 * 1024 * 1024;
export const optionSetReleaseRecordMaximumBytes = 1024 * 1024;
const fail = (): never => {
  throw new CatalogError("CATALOG_INPUT_INVALID");
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, keys: readonly string[]) {
  const copied = copyCategoryPersistenceValue(value);
  if (!copied || typeof copied !== "object" || Array.isArray(copied)) return fail();
  const r = copied as Record<string, unknown>;
  if (Object.keys(r).length !== keys.length || keys.some((key) => !Object.hasOwn(r, key)))
    return fail();
  return r;
}
function digest(value: unknown) {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value)) return fail();
  return value;
}
export function parseCatalogOptionSetStoredReviewBinding(value: unknown) {
  const r = closed(value, [
    "profile",
    "tenantReference",
    "brandReference",
    "optionSetReference",
    "versionReference",
    "expectedAggregateVersion",
    "sourceDigest",
    "contentDigest",
    "configurationDigest",
    "graphDigest",
    "policyReference",
    "policyVersion",
    "policyContentDigest",
    "currentPolicyPublicationReference",
    "originalIntentDigest",
    "activationAt",
    "digest",
  ]);
  const { profile, digest: originalDigest, ...preimage } = r;
  const binding = createCatalogOptionSetContentReviewBinding(preimage);
  if (profile !== binding.profile || originalDigest !== binding.digest) return fail();
  return binding;
}
const reviewKeys = [
  "operationReference",
  "sourceOperationReference",
  "lifecycleReference",
  "actorReference",
  "auditReference",
  "reasonCode",
  "recordedAt",
  "binding",
  "content",
] as const;
/** Original reviewed preimage and full owning content, not validation or approval. */
export function createCatalogOptionSetReviewRecord(value: unknown) {
  const r = closed(value, reviewKeys);
  if (parseCatalogCode(r.reasonCode) !== r.reasonCode) return fail();
  const binding = parseCatalogOptionSetStoredReviewBinding(r.binding);
  const raw = copyCategoryPersistenceValue(r.content);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail();
  const { sourceAggregate, ...additional } = raw as Record<string, unknown>;
  const prepared = parseCatalogOptionSetEditorContent(sourceAggregate, additional);
  const root = prepared.content.sourceAggregate,
    recordedAt = parseCatalogInstant(r.recordedAt);
  if (
    root.brandReference !== binding.brandReference ||
    root.optionSetReference !== binding.optionSetReference ||
    root.draft.versionReference !== binding.versionReference ||
    root.aggregateVersion !== binding.expectedAggregateVersion ||
    prepared.sourceDigest !== binding.sourceDigest ||
    prepared.contentDigest !== binding.contentDigest ||
    prepared.configurationDigest !== binding.configurationDigest ||
    root.updatedAt > recordedAt
  )
    return fail();
  const body = Object.freeze({
    profile: "CatalogOptionSetReviewRecordV1" as const,
    operationReference: parseCatalogReference(r.operationReference),
    sourceOperationReference: parseCatalogReference(r.sourceOperationReference),
    lifecycleReference: parseCatalogReference(r.lifecycleReference),
    actorReference: parseCatalogReference(r.actorReference),
    auditReference: parseCatalogReference(r.auditReference),
    reasonCode: parseCatalogCode(r.reasonCode),
    recordedAt,
    binding,
    content: prepared.content,
  });
  const result = Object.freeze({ ...body, digest: hash(body) });
  if (
    new TextEncoder().encode(canonicalizeRfc8785(result)).byteLength >
    optionSetReviewRecordMaximumBytes
  )
    return fail();
  return result;
}
export type CatalogOptionSetReviewRecord = ReturnType<typeof createCatalogOptionSetReviewRecord>;
export function parseCatalogOptionSetReviewRecord(value: unknown) {
  const r = closed(value, ["profile", ...reviewKeys, "digest"]);
  const { profile, digest: originalDigest, ...preimage } = r;
  const result = createCatalogOptionSetReviewRecord(preimage);
  if (profile !== result.profile || originalDigest !== result.digest) return fail();
  return result;
}
function releasePacket(value: unknown) {
  const r = closed(value, [
    "releaseId",
    "familyReference",
    "configurationType",
    "purposeCode",
    "snapshotReference",
    "snapshotDigest",
    "scope",
    "sequence",
    "sourceLifecycleId",
    "kind",
    "previousReleaseId",
    "createdAt",
  ]);
  const scope = closed(r.scope, ["kind", "brandReference", "storeReference"]);
  if (
    (scope.kind !== "Brand" && scope.kind !== "Store") ||
    (r.kind !== "Publish" && r.kind !== "Rollback")
  )
    return fail();
  return createPublishingReleaseRecord({
    releaseId: parsePublishingReference(r.releaseId),
    familyReference: parsePublishingReference(r.familyReference),
    configurationType: parsePublishingCode(r.configurationType),
    purposeCode: parsePublishingCode(r.purposeCode),
    snapshotReference: parsePublishingReference(r.snapshotReference),
    snapshotDigest: parsePublishingDigest(r.snapshotDigest),
    scope: createPublishingScope({
      kind: scope.kind,
      brandReference: parsePublishingReference(scope.brandReference),
      storeReference:
        scope.storeReference === null ? null : parsePublishingReference(scope.storeReference),
    }),
    sequence: parseReleaseSequence(r.sequence),
    sourceLifecycleId: parsePublishingReference(r.sourceLifecycleId),
    kind: r.kind,
    previousReleaseId:
      r.previousReleaseId === null ? null : parsePublishingReference(r.previousReleaseId),
    createdAt: parsePublishingInstant(r.createdAt),
  });
}
const releaseKeys = [
  "tenantReference",
  "brandReference",
  "optionSetReference",
  "versionReference",
  "operationReference",
  "reviewOperationReference",
  "reviewRecordDigest",
  "reviewBindingDigest",
  "sealOperationReference",
  "sealRecordDigest",
  "publishingOperationReference",
  "actorReference",
  "auditReference",
  "reasonCode",
  "recordedAt",
  "release",
] as const;
/** Recorded cross-owner linkage only. A valid packet does not prove currentness. */
export function createCatalogOptionSetReleaseRecord(value: unknown) {
  const r = closed(value, releaseKeys);
  if (parseCatalogCode(r.reasonCode) !== r.reasonCode) return fail();
  const release = releasePacket(r.release);
  const tenantReference = parseCatalogReference(r.tenantReference),
    brandReference = parseCatalogReference(r.brandReference),
    optionSetReference = parseCatalogReference(r.optionSetReference),
    versionReference = parseCatalogReference(r.versionReference),
    recordedAt = parseCatalogInstant(r.recordedAt),
    reviewBindingDigest = digest(r.reviewBindingDigest);
  if (
    String(release.familyReference) !== optionSetReference ||
    String(release.snapshotReference) !== versionReference ||
    release.snapshotDigest !== reviewBindingDigest ||
    release.configurationType !== "CATALOG_OPTION_SET" ||
    release.purposeCode !== "CATALOG_OPTION_SET_PUBLICATION" ||
    release.scope.brandReference === null ||
    String(release.scope.brandReference) !== brandReference ||
    String(release.createdAt) !== String(recordedAt) ||
    release.kind !== "Publish"
  )
    return fail();
  const body = Object.freeze({
    profile: "CatalogOptionSetReleaseRecordV1" as const,
    tenantReference,
    brandReference,
    optionSetReference,
    versionReference,
    operationReference: parseCatalogReference(r.operationReference),
    reviewOperationReference: parseCatalogReference(r.reviewOperationReference),
    reviewRecordDigest: digest(r.reviewRecordDigest),
    reviewBindingDigest,
    sealOperationReference: parseCatalogReference(r.sealOperationReference),
    sealRecordDigest: digest(r.sealRecordDigest),
    publishingOperationReference: parseCatalogReference(r.publishingOperationReference),
    actorReference: parseCatalogReference(r.actorReference),
    auditReference: parseCatalogReference(r.auditReference),
    reasonCode: parseCatalogCode(r.reasonCode),
    recordedAt,
    release,
  });
  const result = Object.freeze({ ...body, digest: hash(body) });
  if (
    new TextEncoder().encode(canonicalizeRfc8785(result)).byteLength >
    optionSetReleaseRecordMaximumBytes
  )
    return fail();
  return result;
}
export type CatalogOptionSetReleaseRecord = ReturnType<typeof createCatalogOptionSetReleaseRecord>;
export function parseCatalogOptionSetReleaseRecord(value: unknown) {
  const r = closed(value, ["profile", ...releaseKeys, "digest"]);
  const { profile, digest: originalDigest, ...preimage } = r;
  const result = createCatalogOptionSetReleaseRecord(preimage);
  if (profile !== result.profile || originalDigest !== result.digest) return fail();
  return result;
}
