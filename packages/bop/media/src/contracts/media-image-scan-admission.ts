import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaScope,
  parseAssetVersionReference,
  parseMediaInstant,
  parseMediaReferenceId,
  parseObjectEvidenceReference,
  type MediaScope,
} from "./media.js";
import { copyMediaUploadStorageValue } from "./media-upload-storage.js";

/** Private delivery provenance populated by the configured AWS adapter. Parsing
 * these fields is structural validation, never authentication of a delivery. */
export interface MediaImageScanTransport {
  readonly profile: "GUARDDUTY_SQS_DELIVERY_V1";
  readonly deploymentConfigurationDigest: string;
  readonly queueArn: string;
  readonly queueCreatedAt: string;
  readonly queuePolicyDigest: string;
  readonly bodyDigest: string;
  readonly messageId: string;
  readonly sentAt: string;
  readonly receivedAt: string;
}
export interface MediaImageScanDelivery {
  readonly scanEvent: unknown;
  readonly transport: MediaImageScanTransport;
}
export interface MediaImageScanAdmission {
  readonly profile: "MEDIA_IMAGE_SCAN_ADMISSION_V1";
  readonly admissionReference: string;
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly workloadReference: string;
  readonly deploymentConfigurationDigest: string;
  readonly quarantineConfigurationDigest: string;
  readonly providerAccount: string;
  readonly region: "ca-central-1";
  readonly protectionPlanArn: string;
  readonly eventId: string;
  readonly scanEventDigest: string;
  readonly scanEvent: unknown;
  readonly sourceAssetVersionReference: string;
  readonly sourceBindingDigest: string;
  readonly object: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
    readonly etag: string;
    readonly objectEvidenceReference: string;
    readonly providerObjectVersion: string;
  };
  readonly transport: MediaImageScanTransport;
  readonly admittedAt: string;
  readonly auditReference: string;
  readonly correlationId: string;
  readonly digest: string;
}
export class MediaImageScanAdmissionError extends Error {
  constructor(
    readonly code:
      | "MEDIA_IMAGE_SCAN_ADMISSION_UNAVAILABLE"
      | "MEDIA_IMAGE_SCAN_ADMISSION_OUTCOME_UNKNOWN" = "MEDIA_IMAGE_SCAN_ADMISSION_UNAVAILABLE",
  ) {
    super(
      code === "MEDIA_IMAGE_SCAN_ADMISSION_UNAVAILABLE"
        ? "Media scan admission is unavailable"
        : "Media scan admission commit outcome is unknown",
    );
    this.name = "MediaImageScanAdmissionError";
  }
}
const fail = (): never => {
  throw new MediaImageScanAdmissionError();
};
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
const text = (v: unknown, pattern: RegExp): string =>
  typeof v === "string" && pattern.test(v) ? v : fail();
function closed(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[key] = d.value;
  }
  return r;
}
export function mediaImageScanAdmissionHash(value: unknown): string {
  return "sha256:" + sha256Hex(canonicalizeRfc8785(value));
}
function transport(value: unknown): MediaImageScanTransport {
  const r = closed(value, [
    "profile",
    "deploymentConfigurationDigest",
    "queueArn",
    "queueCreatedAt",
    "queuePolicyDigest",
    "bodyDigest",
    "messageId",
    "sentAt",
    "receivedAt",
  ]);
  if (r.profile !== "GUARDDUTY_SQS_DELIVERY_V1") return fail();
  const queueCreatedAt = parseMediaInstant(r.queueCreatedAt),
    sentAt = parseMediaInstant(r.sentAt),
    receivedAt = parseMediaInstant(r.receivedAt);
  if (queueCreatedAt > sentAt || sentAt > receivedAt) return fail();
  return Object.freeze({
    profile: "GUARDDUTY_SQS_DELIVERY_V1",
    deploymentConfigurationDigest: hash(r.deploymentConfigurationDigest),
    queueArn: text(r.queueArn, /^arn:aws:sqs:ca-central-1:[0-9]{12}:[A-Za-z0-9_-]{1,80}$/u),
    queueCreatedAt,
    queuePolicyDigest: hash(r.queuePolicyDigest),
    bodyDigest: hash(r.bodyDigest),
    messageId: text(r.messageId, /^[A-Za-z0-9-]{1,128}$/u),
    sentAt,
    receivedAt,
  });
}
function event(value: unknown) {
  const r = closed(value, [
      "version",
      "id",
      "account",
      "region",
      "time",
      "resources",
      "source",
      "detail-type",
      "detail",
    ]),
    d = closed(r.detail, [
      "schemaVersion",
      "scanStatus",
      "resourceType",
      "s3ObjectDetails",
      "scanResultDetails",
    ]),
    o = closed(d.s3ObjectDetails, ["bucketName", "objectKey", "eTag", "versionId", "s3Throttled"]),
    result = closed(d.scanResultDetails, ["scanResultStatus", "threats", "statusReasons"]);
  if (
    r.version !== "0" ||
    r.region !== "ca-central-1" ||
    r.source !== "aws.guardduty" ||
    r["detail-type"] !== "GuardDuty Malware Protection Object Scan Result" ||
    d.schemaVersion !== "1.0" ||
    d.scanStatus !== "COMPLETED" ||
    d.resourceType !== "S3_OBJECT" ||
    typeof o.s3Throttled !== "boolean" ||
    result.scanResultStatus !== "NO_THREATS_FOUND" ||
    result.threats !== null ||
    result.statusReasons !== null ||
    !Array.isArray(r.resources) ||
    r.resources.length !== 1
  )
    return fail();
  const account = text(r.account, /^[0-9]{12}$/u),
    id = text(r.id, /^[A-Za-z0-9-]{1,128}$/u),
    plan = text(
      r.resources[0],
      new RegExp(
        "^arn:aws:guardduty:ca-central-1:" +
          account +
          ":malware-protection-plan/[A-Za-z0-9]{1,64}$",
        "u",
      ),
    );
  // GuardDuty's envelope time permits canonical seconds as well as milliseconds.
  if (
    typeof r.time !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(r.time) ||
    !Number.isFinite(Date.parse(r.time)) ||
    new Date(r.time).toISOString() !== r.time.replace(/(?<=:\d{2})Z$/u, ".000Z")
  )
    return fail();
  return { account, id, plan, object: o };
}
export function parseMediaImageScanDelivery(value: unknown): MediaImageScanDelivery {
  try {
    const r = closed(copyMediaUploadStorageValue(value), ["scanEvent", "transport"]);
    event(r.scanEvent);
    return Object.freeze({ scanEvent: r.scanEvent, transport: transport(r.transport) });
  } catch {
    return fail();
  }
}
const recordKeys = [
  "profile",
  "admissionReference",
  "tenantReference",
  "scope",
  "workloadReference",
  "deploymentConfigurationDigest",
  "quarantineConfigurationDigest",
  "providerAccount",
  "region",
  "protectionPlanArn",
  "eventId",
  "scanEventDigest",
  "scanEvent",
  "sourceAssetVersionReference",
  "sourceBindingDigest",
  "object",
  "transport",
  "admittedAt",
  "auditReference",
  "correlationId",
] as const;
function recordBody(value: unknown): Omit<MediaImageScanAdmission, "digest"> {
  const r = closed(copyMediaUploadStorageValue(value), recordKeys),
    o = closed(r.object, [
      "bucket",
      "key",
      "versionId",
      "etag",
      "objectEvidenceReference",
      "providerObjectVersion",
    ]),
    details = event(r.scanEvent),
    t = transport(r.transport),
    admittedAt = parseMediaInstant(r.admittedAt),
    deploymentConfigurationDigest = hash(r.deploymentConfigurationDigest),
    scanEventDigest = hash(r.scanEventDigest);
  if (
    r.profile !== "MEDIA_IMAGE_SCAN_ADMISSION_V1" ||
    r.region !== "ca-central-1" ||
    r.providerAccount !== details.account ||
    r.protectionPlanArn !== details.plan ||
    r.eventId !== details.id ||
    scanEventDigest !== mediaImageScanAdmissionHash(r.scanEvent) ||
    t.deploymentConfigurationDigest !== deploymentConfigurationDigest ||
    !t.queueArn.startsWith(`arn:aws:sqs:ca-central-1:${details.account}:`) ||
    t.receivedAt > admittedAt ||
    Date.parse((r.scanEvent as Record<string, unknown>).time as string) > Date.parse(admittedAt)
  )
    return fail();
  const object = Object.freeze({
    bucket: text(o.bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u),
    key: text(o.key, /^(?:[a-z0-9][a-z0-9_-]{0,31}\/){1,4}[a-f0-9]{64}$/u),
    versionId: text(o.versionId, /^[\x21-\x7e]{1,1024}$/u),
    etag: text(o.etag, /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/u),
    objectEvidenceReference: parseObjectEvidenceReference(o.objectEvidenceReference),
    providerObjectVersion: parseMediaReferenceId(o.providerObjectVersion),
  });
  if (
    object.versionId === "null" ||
    object.bucket !== details.object.bucketName ||
    object.key !== details.object.objectKey ||
    object.versionId !== details.object.versionId ||
    object.etag !== details.object.eTag
  )
    return fail();
  return Object.freeze({
    profile: "MEDIA_IMAGE_SCAN_ADMISSION_V1",
    admissionReference: parseMediaReferenceId(r.admissionReference),
    tenantReference: parseMediaReferenceId(r.tenantReference),
    scope: createMediaScope(r.scope as MediaScope),
    workloadReference: parseMediaReferenceId(r.workloadReference),
    deploymentConfigurationDigest,
    quarantineConfigurationDigest: hash(r.quarantineConfigurationDigest),
    providerAccount: details.account,
    region: "ca-central-1",
    protectionPlanArn: details.plan,
    eventId: details.id,
    scanEventDigest,
    scanEvent: r.scanEvent,
    sourceAssetVersionReference: parseAssetVersionReference(r.sourceAssetVersionReference),
    sourceBindingDigest: hash(r.sourceBindingDigest),
    object,
    transport: t,
    admittedAt,
    auditReference: parseMediaReferenceId(r.auditReference),
    correlationId: parseMediaReferenceId(r.correlationId),
  });
}
export function buildMediaImageScanAdmission(
  value: Omit<MediaImageScanAdmission, "digest">,
): MediaImageScanAdmission {
  try {
    const body = recordBody(value);
    return boundedRecord({ ...body, digest: mediaImageScanAdmissionHash(body) });
  } catch {
    return fail();
  }
}
export function parseMediaImageScanAdmission(value: unknown): MediaImageScanAdmission {
  try {
    const r = closed(copyMediaUploadStorageValue(value), [...recordKeys, "digest"]),
      digest = hash(r.digest);
    delete r.digest;
    const body = recordBody(r);
    if (digest !== mediaImageScanAdmissionHash(body)) return fail();
    return boundedRecord({ ...body, digest });
  } catch {
    return fail();
  }
}
function boundedRecord(value: MediaImageScanAdmission): MediaImageScanAdmission {
  // Match jsonb::text's separators for this closed, already parsed ASCII record.
  const encoded = (v: unknown): string => {
    if (Array.isArray(v)) return "[" + v.map(encoded).join(", ") + "]";
    if (v !== null && typeof v === "object")
      return (
        "{" +
        Object.entries(v)
          .map(([k, item]) => JSON.stringify(k) + ": " + encoded(item))
          .join(", ") +
        "}"
      );
    const result = JSON.stringify(v);
    return typeof result === "string" ? result : fail();
  };
  if (Buffer.byteLength(encoded(value), "utf8") > 65536) return fail();
  return Object.freeze(value);
}
