import { randomBytes } from "node:crypto";
import { v7 as uuidV7 } from "uuid";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  MediaContractError,
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
  parseAssetReference,
  parseAssetVersionReference,
  parseMediaChecksum,
  parseMediaInstant,
  parseMediaReferenceId,
  parseMediaVersion,
  parseObjectEvidenceReference,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaScope,
  type UploadSession,
} from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import type {
  createS3QuarantineImageSource,
  S3QuarantineImageReadInput,
} from "../provider/s3-quarantine-image-source.js";

export interface PlannedImageObject {
  readonly key: string;
  readonly objectEvidenceReference: string;
  readonly providerObjectVersion: string;
}
export interface PlannedImageRendition extends PlannedImageObject {
  readonly contentType: "image/jpeg" | "image/webp";
  readonly width: 320 | 640 | 1280;
}
export interface MediaImagePromotionPlan {
  readonly profile: "PUBLIC_IMAGE_V1";
  readonly operationReference: string;
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly assetReference: string;
  readonly sourceAssetVersionReference: string;
  readonly targetAssetVersionReference: string;
  readonly expectedAssetVersion: number;
  readonly sourceBindingDigest: string;
  readonly destination: {
    readonly accountId: string;
    readonly bucket: string;
    readonly cleanPrefix: string;
    readonly kmsKeyArn: string;
  };
  readonly original: PlannedImageObject;
  readonly renditions: readonly PlannedImageRendition[];
}
export interface MediaPromotedObject extends PlannedImageObject {
  readonly bucket: string;
  readonly versionId: string;
  readonly etag: string;
  readonly contentType: string;
  readonly byteSize: number;
  readonly checksum: string;
}
export interface MediaPromotedRendition extends MediaPromotedObject {
  readonly contentType: "image/jpeg" | "image/webp";
  readonly width: 320 | 640 | 1280;
  readonly height: number;
}
type ReadResult = Awaited<ReturnType<ReturnType<typeof createS3QuarantineImageSource>["read"]>>;
export interface MediaImagePromotionResult {
  readonly profile: "PUBLIC_IMAGE_RESULT_V1";
  readonly operationReference: string;
  readonly planDigest: string;
  readonly sourceEvidence: ReadResult["objectEvidence"];
  readonly scanEvidence: ReadResult["scanEvidence"];
  readonly original: MediaPromotedObject;
  readonly renditions: readonly MediaPromotedRendition[];
  readonly completedAt: string;
}

const maximumObjectBytes = 10 * 1024 * 1024;
const maximumRenditionBytes = 30 * 1024 * 1024;
const objectFields = ["key", "objectEvidenceReference", "providerObjectVersion"] as const;
const baseFields = [
  "operationReference",
  "tenantReference",
  "scope",
  "assetReference",
  "sourceAssetVersionReference",
  "targetAssetVersionReference",
  "expectedAssetVersion",
  "sourceBindingDigest",
  "destination",
] as const;
const specifications = [
  { width: 320, contentType: "image/jpeg" },
  { width: 320, contentType: "image/webp" },
  { width: 640, contentType: "image/jpeg" },
  { width: 640, contentType: "image/webp" },
  { width: 1280, contentType: "image/jpeg" },
  { width: 1280, contentType: "image/webp" },
] as const;
const fail = (): never => {
  throw new MediaContractError("MEDIA_INPUT_INVALID");
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : fail();
}
function integer(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum
    ? value
    : fail();
}
function bucket(value: unknown): string {
  const result = text(value, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u);
  if (result.startsWith("xn--") || /(?:-s3alias|--ol-s3|--x-s3)$/u.test(result)) return fail();
  return result;
}
function kmsKey(value: unknown, accountId: string): string {
  return text(
    value,
    new RegExp(
      "^arn:aws:kms:ca-central-1:" +
        accountId +
        ":key/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$",
      "u",
    ),
  );
}
function versionId(value: unknown): string {
  const result = text(value, /^[\x21-\x7e]{1,1024}$/u);
  return result !== "null" ? result : fail();
}
const etag = (value: unknown) => text(value, /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/u);
export function parseMediaImagePromotionDestination(
  value: unknown,
): MediaImagePromotionPlan["destination"] {
  const d = closed(copyMediaUploadStorageValue(value), [
    "accountId",
    "bucket",
    "cleanPrefix",
    "kmsKeyArn",
  ]);
  const accountId = text(d.accountId, /^\d{12}$/u);
  return Object.freeze({
    accountId,
    bucket: bucket(d.bucket),
    cleanPrefix: text(d.cleanPrefix, /^(?:[a-z0-9][a-z0-9_-]{0,31}\/){1,4}$/u),
    kmsKeyArn: kmsKey(d.kmsKeyArn, accountId),
  });
}
function base(
  r: Record<string, unknown>,
): Omit<MediaImagePromotionPlan, "profile" | "original" | "renditions"> {
  const destination = parseMediaImagePromotionDestination(r.destination);
  const sourceAssetVersionReference = parseAssetVersionReference(r.sourceAssetVersionReference);
  const targetAssetVersionReference = parseAssetVersionReference(r.targetAssetVersionReference);
  if (sourceAssetVersionReference === targetAssetVersionReference) return fail();
  return Object.freeze({
    operationReference: parseMediaReferenceId(r.operationReference),
    tenantReference: parseMediaReferenceId(r.tenantReference),
    scope: createMediaScope(r.scope as MediaScope),
    assetReference: parseAssetReference(r.assetReference),
    sourceAssetVersionReference,
    targetAssetVersionReference,
    expectedAssetVersion: parseMediaVersion(r.expectedAssetVersion),
    sourceBindingDigest: parseMediaChecksum(r.sourceBindingDigest),
    destination,
  });
}
function planned(r: Record<string, unknown>, prefix: string): PlannedImageObject {
  if (
    typeof r.key !== "string" ||
    !r.key.startsWith(prefix) ||
    !/^[a-f0-9]{64}$/u.test(r.key.slice(prefix.length))
  )
    return fail();
  return Object.freeze({
    key: r.key,
    objectEvidenceReference: parseObjectEvidenceReference(r.objectEvidenceReference),
    providerObjectVersion: parseMediaReferenceId(r.providerObjectVersion),
  });
}

/** Private stored intent. Parsing proves closed shape and linkage, not System
 * authority or the source binding's provenance. The owning store supplies that digest. */
export function parseMediaImagePromotionPlan(value: unknown): MediaImagePromotionPlan {
  const r = closed(copyMediaUploadStorageValue(value), [
    "profile",
    ...baseFields,
    "original",
    "renditions",
  ]);
  const b = base(r);
  if (r.profile !== "PUBLIC_IMAGE_V1" || !Array.isArray(r.renditions) || r.renditions.length !== 6)
    return fail();
  const original = planned(closed(r.original, objectFields), b.destination.cleanPrefix);
  const renditions = r.renditions.map((value, index): PlannedImageRendition => {
    const item = closed(value, [...objectFields, "contentType", "width"]),
      spec = specifications[index];
    if (!spec || item.width !== spec.width || item.contentType !== spec.contentType) return fail();
    return Object.freeze({ ...planned(item, b.destination.cleanPrefix), ...spec });
  });
  const objects = [original, ...renditions];
  if (
    new Set(objects.map((o) => o.key)).size !== 7 ||
    new Set(objects.flatMap((o) => [o.objectEvidenceReference, o.providerObjectVersion])).size !==
      14
  )
    return fail();
  return Object.freeze({
    profile: "PUBLIC_IMAGE_V1",
    ...b,
    original,
    renditions: Object.freeze(renditions),
  });
}
export function mediaImagePromotionPlanDigest(plan: MediaImagePromotionPlan): string {
  return "sha256:" + sha256Hex(canonicalizeRfc8785(parseMediaImagePromotionPlan(plan)));
}
export function createMediaImagePromotionPlan(
  input: Omit<MediaImagePromotionPlan, "profile" | "original" | "renditions">,
): MediaImagePromotionPlan {
  const b = base(closed(copyMediaUploadStorageValue(input), baseFields));
  const object = (): PlannedImageObject => ({
    key: b.destination.cleanPrefix + randomBytes(32).toString("hex"),
    objectEvidenceReference: uuidV7(),
    providerObjectVersion: uuidV7(),
  });
  return parseMediaImagePromotionPlan({
    profile: "PUBLIC_IMAGE_V1",
    ...b,
    original: object(),
    renditions: specifications.map((spec) => ({ ...object(), ...spec })),
  });
}

function sourceBinding(value: S3QuarantineImageReadInput, plan: MediaImagePromotionPlan) {
  const r = closed(copyMediaUploadStorageValue(value), [
    "tenantReference",
    "session",
    "asset",
    "assetVersion",
    "object",
    "scanEvent",
  ]);
  const session = createUploadSession(r.session as UploadSession),
    asset = createMediaAsset(r.asset as MediaAsset),
    assetVersion = createMediaAssetVersion(r.assetVersion as MediaAssetVersion);
  const o = closed(r.object, [
    "bucket",
    "key",
    "versionId",
    "etag",
    "objectEvidenceReference",
    "providerObjectVersion",
  ]);
  const object = Object.freeze({
    bucket: bucket(o.bucket),
    key: text(o.key, /^(?:[a-z0-9][a-z0-9_-]{0,31}\/){1,4}[a-f0-9]{64}$/u),
    versionId: versionId(o.versionId),
    etag: etag(o.etag),
    objectEvidenceReference: parseObjectEvidenceReference(o.objectEvidenceReference),
    providerObjectVersion: parseMediaReferenceId(o.providerObjectVersion),
  });
  if (
    r.tenantReference !== plan.tenantReference ||
    !equal(session.scope, plan.scope) ||
    !equal(asset.scope, plan.scope) ||
    session.state !== "Finalized" ||
    session.version !== 2 ||
    session.mediaKind !== "Image" ||
    asset.mediaKind !== "Image" ||
    asset.version !== 1 ||
    asset.currentVersionReference !== null ||
    asset.assetId !== plan.assetReference ||
    assetVersion.assetId !== asset.assetId ||
    assetVersion.assetVersionId !== plan.sourceAssetVersionReference ||
    assetVersion.version !== 1 ||
    assetVersion.checkState !== "Quarantined" ||
    assetVersion.readinessState !== "Pending" ||
    assetVersion.byteSize > maximumObjectBytes ||
    !["image/jpeg", "image/png", "image/webp"].includes(assetVersion.contentType) ||
    session.declaredContentType !== assetVersion.contentType ||
    session.declaredByteSize !== assetVersion.byteSize ||
    session.ownerReference !== asset.ownerReference ||
    session.ownerType !== asset.ownerType ||
    session.purpose !== asset.purpose ||
    session.classification !== asset.classification ||
    assetVersion.createdAt < session.createdAt ||
    assetVersion.createdAt >= session.expiresAt ||
    object.objectEvidenceReference !== assetVersion.objectEvidenceReference ||
    object.providerObjectVersion !== assetVersion.providerObjectVersion
  )
    return fail();
  // This is the immutable initial upload snapshot, not today's Asset CAS root.
  // expectedAssetVersion belongs to the separate owning completion transaction.
  for (const output of [plan.original, ...plan.renditions]) {
    if (
      (plan.destination.bucket === object.bucket && output.key === object.key) ||
      [output.objectEvidenceReference, output.providerObjectVersion].some(
        (reference) =>
          reference === object.objectEvidenceReference ||
          reference === object.providerObjectVersion,
      )
    )
      return fail();
  }
  return { session, asset, assetVersion, object, scanEvent: r.scanEvent };
}
function scan(
  value: unknown,
  accountId: string,
  object: S3QuarantineImageReadInput["object"],
): ReadResult["scanEvidence"] {
  // Same official closed GuardDuty result shape as the quarantine reader. This
  // comparison authenticates neither EventBridge ingress nor the tag writer.
  const r = closed(value, [
    "version",
    "id",
    "detail-type",
    "source",
    "account",
    "time",
    "region",
    "resources",
    "detail",
  ]);
  const d = closed(r.detail, [
    "schemaVersion",
    "scanStatus",
    "resourceType",
    "s3ObjectDetails",
    "scanResultDetails",
  ]);
  const s3 = closed(d.s3ObjectDetails, [
    "bucketName",
    "objectKey",
    "eTag",
    "versionId",
    "s3Throttled",
  ]);
  const result = closed(d.scanResultDetails, ["scanResultStatus", "threats", "statusReasons"]);
  const eventId = text(r.id, /^[A-Za-z0-9-]{1,128}$/u);
  const eventTime = text(r.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u);
  parseMediaInstant(eventTime.includes(".") ? eventTime : eventTime.replace(/Z$/u, ".000Z"));
  if (!Array.isArray(r.resources) || r.resources.length !== 1) return fail();
  const protectionPlanArn = text(
    r.resources[0],
    new RegExp(
      "^arn:aws:guardduty:ca-central-1:" +
        accountId +
        ":malware-protection-plan/[a-zA-Z0-9]{1,64}$",
      "u",
    ),
  );
  if (
    r.version !== "0" ||
    r["detail-type"] !== "GuardDuty Malware Protection Object Scan Result" ||
    r.source !== "aws.guardduty" ||
    r.account !== accountId ||
    r.region !== "ca-central-1" ||
    d.schemaVersion !== "1.0" ||
    d.scanStatus !== "COMPLETED" ||
    d.resourceType !== "S3_OBJECT" ||
    s3.bucketName !== object.bucket ||
    s3.objectKey !== object.key ||
    s3.eTag !== object.etag ||
    s3.versionId !== object.versionId ||
    typeof s3.s3Throttled !== "boolean" ||
    result.scanResultStatus !== "NO_THREATS_FOUND" ||
    result.threats !== null ||
    result.statusReasons !== null
  )
    return fail();
  return Object.freeze({
    eventId,
    eventTime,
    accountId,
    region: "ca-central-1",
    protectionPlanArn,
    result: "NO_THREATS_FOUND",
    s3Throttled: s3.s3Throttled,
  });
}
function promoted(
  r: Record<string, unknown>,
  p: PlannedImageObject,
  destination: MediaImagePromotionPlan["destination"],
): MediaPromotedObject {
  if (
    r.key !== p.key ||
    r.objectEvidenceReference !== p.objectEvidenceReference ||
    r.providerObjectVersion !== p.providerObjectVersion ||
    r.bucket !== destination.bucket
  )
    return fail();
  return Object.freeze({
    ...p,
    bucket: destination.bucket,
    versionId: versionId(r.versionId),
    etag: etag(r.etag),
    contentType: text(r.contentType, /^image\/(?:jpeg|png|webp)$/u),
    byteSize: integer(r.byteSize, maximumObjectBytes),
    checksum: parseMediaChecksum(r.checksum),
  });
}

/** Private immutable completion evidence. The actual writer verifies bytes and
 * S3 metadata; the owning transaction verifies authority, current root and the
 * persisted source binding. This parser supplies none of those external facts. */
export function parseMediaImagePromotionResult(
  value: unknown,
  planValue: MediaImagePromotionPlan,
  source: S3QuarantineImageReadInput,
): MediaImagePromotionResult {
  const plan = parseMediaImagePromotionPlan(planValue),
    b = sourceBinding(source, plan);
  const r = closed(copyMediaUploadStorageValue(value), [
    "profile",
    "operationReference",
    "planDigest",
    "sourceEvidence",
    "scanEvidence",
    "original",
    "renditions",
    "completedAt",
  ]);
  const evidence = closed(r.sourceEvidence, [
    "bucket",
    "key",
    "versionId",
    "etag",
    "objectEvidenceReference",
    "providerObjectVersion",
    "tenantReference",
    "scope",
    "uploadSessionReference",
    "assetReference",
    "assetVersionReference",
    "byteSize",
    "checksum",
    "kmsKeyArn",
  ]);
  const sourceEvidence: ReadResult["objectEvidence"] = Object.freeze({
    ...b.object,
    tenantReference: plan.tenantReference,
    scope: plan.scope,
    uploadSessionReference: b.session.uploadSessionId,
    assetReference: b.asset.assetId,
    assetVersionReference: b.assetVersion.assetVersionId,
    byteSize: b.assetVersion.byteSize,
    checksum: b.assetVersion.checksum,
    kmsKeyArn: kmsKey(evidence.kmsKeyArn, plan.destination.accountId),
  });
  const scanEvidence = scan(b.scanEvent, plan.destination.accountId, b.object),
    completedAt = parseMediaInstant(r.completedAt);
  if (
    r.profile !== "PUBLIC_IMAGE_RESULT_V1" ||
    r.operationReference !== plan.operationReference ||
    r.planDigest !== mediaImagePromotionPlanDigest(plan) ||
    !equal(evidence, sourceEvidence) ||
    !equal(r.scanEvidence, scanEvidence) ||
    completedAt < b.assetVersion.createdAt ||
    Date.parse(completedAt) < Date.parse(scanEvidence.eventTime) ||
    !Array.isArray(r.renditions) ||
    r.renditions.length !== 6
  )
    return fail();
  const outputFields = [
    ...objectFields,
    "bucket",
    "versionId",
    "etag",
    "contentType",
    "byteSize",
    "checksum",
  ];
  const original = promoted(closed(r.original, outputFields), plan.original, plan.destination);
  if (
    original.contentType !== b.assetVersion.contentType ||
    original.byteSize !== b.assetVersion.byteSize ||
    original.checksum !== b.assetVersion.checksum
  )
    return fail();
  const renditions = r.renditions.map((value, index): MediaPromotedRendition => {
    const item = closed(value, [...outputFields, "width", "height"]),
      expected = plan.renditions[index];
    if (!expected || item.width !== expected.width || item.contentType !== expected.contentType)
      return fail();
    const height = integer(item.height, 16383);
    if (expected.width * height > 25_000_000) return fail();
    return Object.freeze({
      ...promoted(item, expected, plan.destination),
      contentType: expected.contentType,
      width: expected.width,
      height,
    });
  });
  if (renditions.reduce((total, item) => total + item.byteSize, 0) > maximumRenditionBytes)
    return fail();
  for (let i = 0; i < renditions.length; i += 2)
    if (renditions[i]?.height !== renditions[i + 1]?.height) return fail();
  return Object.freeze({
    profile: "PUBLIC_IMAGE_RESULT_V1",
    operationReference: plan.operationReference,
    planDigest: mediaImagePromotionPlanDigest(plan),
    sourceEvidence,
    scanEvidence,
    original,
    renditions: Object.freeze(renditions),
    completedAt,
  });
}
