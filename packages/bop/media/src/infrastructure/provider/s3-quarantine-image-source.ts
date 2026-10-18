import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import {
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
  parseMediaReferenceId,
  parseObjectEvidenceReference,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaScope,
  type UploadSession,
} from "../../contracts/media.js";

// Private upload-grant adapters must use randomBytes(32).toString("hex") for
// this exact basename. A matching name alone does not prove random generation.
export const quarantineImageObjectNameBytes = 32;
export const quarantineImageObjectNamePattern = /^[a-f0-9]{64}$/u;
const maximumBytes = 10 * 1024 * 1024,
  maximumDurationMs = 30000;
const contentTypes = ["image/jpeg", "image/png", "image/webp"] as const;
type ImageContentType = (typeof contentTypes)[number];
type S3ReadCommand = HeadObjectCommand | GetObjectTaggingCommand | GetObjectCommand;
export interface S3QuarantineImageSdk {
  send(command: S3ReadCommand, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
}
export interface S3QuarantineImageConfig {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly region: "ca-central-1";
  readonly accountId: string;
  readonly bucket: string;
  readonly quarantinePrefix: string;
  readonly kmsKeyArn: string;
  readonly protectionPlanArn: string;
}
export interface S3QuarantineImageReadInput {
  readonly tenantReference: string;
  readonly session: UploadSession;
  readonly asset: MediaAsset;
  readonly assetVersion: MediaAssetVersion;
  readonly object: {
    readonly bucket: string;
    readonly key: string;
    readonly versionId: string;
    readonly etag: string;
    readonly objectEvidenceReference: string;
    readonly providerObjectVersion: string;
  };
  readonly scanEvent: unknown;
}
export class MediaQuarantineUnavailableError extends Error {
  readonly code = "MEDIA_QUARANTINE_UNAVAILABLE";
  constructor() {
    super("Media quarantine is unavailable");
    this.name = "MediaQuarantineUnavailableError";
  }
}
const fail = (): never => {
  throw new MediaQuarantineUnavailableError();
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function capture(value: unknown): unknown {
  let remaining = 512;
  const copy = (input: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 10) return fail();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return input.length <= 2048 ? input : fail();
    if (typeof input === "number") return Number.isFinite(input) ? input : fail();
    if (!input || typeof input !== "object") return fail();
    if (Array.isArray(input)) {
      if (
        input.length > 32 ||
        Object.getPrototypeOf(input) !== Array.prototype ||
        Reflect.ownKeys(input).length !== input.length + 1
      )
        return fail();
      return Object.freeze(
        Array.from({ length: input.length }, (_, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          return descriptor?.enumerable && "value" in descriptor
            ? copy(descriptor.value, depth + 1)
            : fail();
        }),
      );
    }
    if (Object.getPrototypeOf(input) !== Object.prototype || Reflect.ownKeys(input).length > 32)
      return fail();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || key === "__proto__") return fail();
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
      result[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(result);
  };
  return copy(value, 0);
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    return fail();
  return value as Record<string, unknown>;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) return fail();
  return descriptor.value;
}
function text(value: unknown, pattern: RegExp): string {
  return typeof value === "string" && pattern.test(value) ? value : fail();
}
export function parseS3QuarantineImageConfig(value: unknown): S3QuarantineImageConfig {
  const r = closed(capture(value), [
      "tenantReference",
      "scope",
      "region",
      "accountId",
      "bucket",
      "quarantinePrefix",
      "kmsKeyArn",
      "protectionPlanArn",
    ]),
    tenantReference = parseMediaReferenceId(r.tenantReference),
    scope = createMediaScope(r.scope as MediaScope),
    accountId = text(r.accountId, /^\d{12}$/u),
    bucket = text(r.bucket, /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u),
    quarantinePrefix = text(r.quarantinePrefix, /^(?:[a-z0-9][a-z0-9_-]{0,31}\/){1,4}$/u),
    kmsKeyArn = text(
      r.kmsKeyArn,
      new RegExp(
        "^arn:aws:kms:ca-central-1:" +
          accountId +
          ":key/(?:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|mrk-[a-f0-9]{32})$",
        "u",
      ),
    ),
    protectionPlanArn = text(
      r.protectionPlanArn,
      new RegExp(
        "^arn:aws:guardduty:ca-central-1:" +
          accountId +
          ":malware-protection-plan/[a-zA-Z0-9]{1,64}$",
        "u",
      ),
    );
  if (
    r.region !== "ca-central-1" ||
    bucket.startsWith("xn--") ||
    /(?:-s3alias|--ol-s3|--x-s3)$/u.test(bucket)
  )
    return fail();
  return Object.freeze({
    tenantReference,
    scope,
    region: "ca-central-1",
    accountId,
    bucket,
    quarantinePrefix,
    kmsKeyArn,
    protectionPlanArn,
  });
}
function event(
  value: unknown,
  c: S3QuarantineImageConfig,
  object: Pick<S3QuarantineImageReadInput["object"], "bucket" | "key" | "versionId" | "etag">,
) {
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
    ]),
    detail = closed(r.detail, [
      "schemaVersion",
      "scanStatus",
      "resourceType",
      "s3ObjectDetails",
      "scanResultDetails",
    ]),
    s3 = closed(detail.s3ObjectDetails, [
      "bucketName",
      "objectKey",
      "eTag",
      "versionId",
      "s3Throttled",
    ]),
    result = closed(detail.scanResultDetails, ["scanResultStatus", "threats", "statusReasons"]),
    eventId = text(r.id, /^[A-Za-z0-9-]{1,128}$/u),
    eventTime = text(r.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u);
  if (
    !Number.isFinite(Date.parse(eventTime)) ||
    new Date(eventTime).toISOString() !==
      (eventTime.includes(".") ? eventTime : eventTime.replace(/Z$/u, ".000Z")) ||
    r.version !== "0" ||
    r["detail-type"] !== "GuardDuty Malware Protection Object Scan Result" ||
    r.source !== "aws.guardduty" ||
    r.account !== c.accountId ||
    r.region !== c.region ||
    !equal(r.resources, [c.protectionPlanArn]) ||
    detail.schemaVersion !== "1.0" ||
    detail.scanStatus !== "COMPLETED" ||
    detail.resourceType !== "S3_OBJECT" ||
    s3.bucketName !== object.bucket ||
    s3.objectKey !== object.key ||
    s3.versionId !== object.versionId ||
    s3.eTag !== object.etag ||
    typeof s3.s3Throttled !== "boolean" ||
    result.scanResultStatus !== "NO_THREATS_FOUND" ||
    result.threats !== null ||
    result.statusReasons !== null
  )
    return fail();
  return Object.freeze({
    eventId,
    eventTime,
    accountId: c.accountId,
    region: c.region,
    protectionPlanArn: c.protectionPlanArn,
    result: "NO_THREATS_FOUND" as const,
    s3Throttled: s3.s3Throttled,
  });
}
// Private owning recovery uses the same event/locator check on captured input.
// This export does not authenticate an EventBridge invocation.
export { event as parseS3QuarantineImageScanEvent };
function binding(value: unknown, c: S3QuarantineImageConfig) {
  const r = closed(capture(value), [
      "tenantReference",
      "session",
      "asset",
      "assetVersion",
      "object",
      "scanEvent",
    ]),
    session = createUploadSession(r.session as UploadSession),
    asset = createMediaAsset(r.asset as MediaAsset),
    assetVersion = createMediaAssetVersion(r.assetVersion as MediaAssetVersion),
    o = closed(r.object, [
      "bucket",
      "key",
      "versionId",
      "etag",
      "objectEvidenceReference",
      "providerObjectVersion",
    ]),
    object = Object.freeze({
      bucket: text(o.bucket, /^[a-z0-9-]{3,63}$/u),
      key: text(o.key, /^[a-z0-9/_-]{1,256}$/u),
      versionId: text(o.versionId, /^[\x21-\x7e]{1,1024}$/u),
      etag: text(o.etag, /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/u),
      objectEvidenceReference: parseObjectEvidenceReference(o.objectEvidenceReference),
      providerObjectVersion: parseMediaReferenceId(o.providerObjectVersion),
    });
  if (
    r.tenantReference !== c.tenantReference ||
    !equal(asset.scope, c.scope) ||
    !equal(session.scope, c.scope) ||
    session.state !== "Finalized" ||
    session.version !== 2 ||
    session.mediaKind !== "Image" ||
    asset.mediaKind !== "Image" ||
    asset.version !== 1 ||
    asset.currentVersionReference !== null ||
    assetVersion.assetId !== asset.assetId ||
    assetVersion.version !== 1 ||
    assetVersion.checkState !== "Quarantined" ||
    assetVersion.readinessState !== "Pending" ||
    assetVersion.byteSize > maximumBytes ||
    !contentTypes.some((type) => type === assetVersion.contentType) ||
    session.declaredContentType !== assetVersion.contentType ||
    session.declaredByteSize !== assetVersion.byteSize ||
    session.ownerReference !== asset.ownerReference ||
    session.ownerType !== asset.ownerType ||
    session.purpose !== asset.purpose ||
    session.classification !== asset.classification ||
    assetVersion.createdAt < session.createdAt ||
    assetVersion.createdAt >= session.expiresAt ||
    object.bucket !== c.bucket ||
    !object.key.startsWith(c.quarantinePrefix) ||
    !quarantineImageObjectNamePattern.test(object.key.slice(c.quarantinePrefix.length)) ||
    object.versionId === "null" ||
    object.objectEvidenceReference !== assetVersion.objectEvidenceReference ||
    object.providerObjectVersion !== assetVersion.providerObjectVersion
  )
    return fail();
  const metadata = Object.freeze({
    "bop-tenant-reference": c.tenantReference,
    "bop-brand-reference": c.scope.brandReference,
    "bop-store-reference": c.scope.storeReference ?? "",
    "bop-upload-session-reference": session.uploadSessionId,
    "bop-actor-reference": session.actorReference,
    "bop-purpose": session.purpose,
    "bop-owner-type": session.ownerType,
    "bop-owner-reference": session.ownerReference,
    "bop-classification": session.classification,
  });
  return {
    session,
    asset,
    assetVersion,
    object,
    metadata,
    scan: event(r.scanEvent, c, object),
    contentType: assetVersion.contentType as ImageContentType,
  };
}
function verifyObject(
  response: unknown,
  b: ReturnType<typeof binding>,
  c: S3QuarantineImageConfig,
): void {
  const checksum = field(response, "ChecksumSHA256"),
    metadata = field(response, "Metadata");
  if (
    field(response, "VersionId") !== b.object.versionId ||
    field(response, "ETag") !== '"' + b.object.etag + '"' ||
    field(response, "ContentLength") !== b.assetVersion.byteSize ||
    field(response, "ContentType") !== b.contentType ||
    field(response, "ServerSideEncryption") !== "aws:kms" ||
    field(response, "SSEKMSKeyId") !== c.kmsKeyArn ||
    field(response, "ChecksumType") !== "FULL_OBJECT" ||
    typeof checksum !== "string" ||
    !/^[A-Za-z0-9+/]{43}=$/u.test(checksum) ||
    Buffer.from(checksum, "base64").toString("base64") !== checksum ||
    "sha256:" + Buffer.from(checksum, "base64").toString("hex") !== b.assetVersion.checksum ||
    field(response, "DeleteMarker") === true ||
    field(response, "ContentRange") !== undefined ||
    field(response, "ContentEncoding") !== undefined
  )
    return fail();
  for (const [key, value] of Object.entries(b.metadata))
    if (field(metadata, key) !== value) return fail();
}
function verifyTags(response: unknown, versionId: string): void {
  const tags = capture(field(response, "TagSet"));
  if (field(response, "VersionId") !== versionId || !Array.isArray(tags) || tags.length > 10)
    return fail();
  const seen = new Set<string>();
  let clean = false;
  for (const entry of tags) {
    const tag = closed(entry, ["Key", "Value"]);
    if (
      typeof tag.Key !== "string" ||
      tag.Key.length < 1 ||
      tag.Key.length > 128 ||
      typeof tag.Value !== "string" ||
      tag.Value.length > 256 ||
      seen.has(tag.Key)
    )
      return fail();
    seen.add(tag.Key);
    if (tag.Key === "GuardDutyMalwareScanStatus") {
      if (tag.Value !== "NO_THREATS_FOUND") return fail();
      clean = true;
    }
  }
  if (!clean) return fail();
}

/** Private provider boundary only. The host must authenticate the EventBridge
 * invocation and protect scan-tag writers by IAM, then supply actual owning
 * stored session/version/object mappings. JSON fields are not that authority.
 * The returned bytes are still untrusted decoder input, never a Clean/Ready asset. */
export function createS3QuarantineImageSource(options: {
  readonly config: S3QuarantineImageConfig;
  readonly sdk?: S3QuarantineImageSdk;
}) {
  let c: S3QuarantineImageConfig, send: S3QuarantineImageSdk["send"];
  try {
    const o = closed(options, Object.hasOwn(options, "sdk") ? ["config", "sdk"] : ["config"]);
    c = parseS3QuarantineImageConfig(field(o, "config"));
    const sdk = field(o, "sdk");
    if (sdk !== undefined) {
      const method = field(sdk, "send");
      if (typeof method !== "function") return fail();
      send = (method as S3QuarantineImageSdk["send"]).bind(sdk);
    } else {
      const client = new S3Client({
        region: "ca-central-1",
        endpoint: "https://s3.ca-central-1.amazonaws.com",
        forcePathStyle: false,
        useArnRegion: false,
        useAccelerateEndpoint: false,
        useGlobalEndpoint: false,
        useDualstackEndpoint: false,
        useFipsEndpoint: false,
        disableMultiregionAccessPoints: true,
        disableS3ExpressSessionAuth: true,
        followRegionRedirects: false,
        maxAttempts: 1,
      });
      send = (command, request) => {
        if (command instanceof HeadObjectCommand) return client.send(command, request);
        if (command instanceof GetObjectTaggingCommand) return client.send(command, request);
        return client.send(command, request);
      };
    }
  } catch {
    return fail();
  }
  return Object.freeze({
    async read(input: S3QuarantineImageReadInput, signal?: AbortSignal) {
      const started = performance.now(),
        controller = new AbortController();
      let body: Readable | undefined;
      const disposeBody = () => {
        try {
          body?.destroy();
        } catch {
          /* Never expose a transport cleanup error. */
        }
      };
      const abort = () => {
          controller.abort();
          disposeBody();
        },
        timer = setTimeout(abort, maximumDurationMs);
      const check = () => {
        if (controller.signal.aborted || performance.now() - started >= maximumDurationMs) {
          abort();
          return fail();
        }
      };
      const interruptible = async <T>(operation: Promise<T>): Promise<T> => {
        let cancel = () => {
          /* The promise executor installs the actual cancellation handler. */
        };
        const aborted = new Promise<never>((_, reject) => {
          cancel = () => reject(new MediaQuarantineUnavailableError());
          controller.signal.addEventListener("abort", cancel, { once: true });
          if (controller.signal.aborted) cancel();
        });
        try {
          if (performance.now() - started >= maximumDurationMs) abort();
          const result = await Promise.race([operation, aborted]);
          check();
          return result;
        } finally {
          controller.signal.removeEventListener("abort", cancel);
        }
      };
      try {
        if (signal !== undefined && !(signal instanceof AbortSignal)) return fail();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const b = binding(input, c);
        check();
        const common = Object.freeze({
          Bucket: c.bucket,
          Key: b.object.key,
          VersionId: b.object.versionId,
          ExpectedBucketOwner: c.accountId,
        });
        const head = await interruptible(
          send(new HeadObjectCommand({ ...common, ChecksumMode: "ENABLED" }), {
            abortSignal: controller.signal,
          }),
        );
        verifyObject(head, b, c);
        check();
        const tags = await interruptible(
          send(new GetObjectTaggingCommand(common), { abortSignal: controller.signal }),
        );
        verifyTags(tags, b.object.versionId);
        check();
        const downloading = send(
          new GetObjectCommand({
            ...common,
            ChecksumMode: "ENABLED",
            IfMatch: '"' + b.object.etag + '"',
          }),
          { abortSignal: controller.signal },
        ).then((response) => {
          // Own the stream before interruptible's completion deadline check.
          // That check may expire before the timeout callback has run. A later
          // response after cancellation must also be disposed here.
          const arrivingBody = field(response, "Body");
          if (arrivingBody instanceof Readable) body = arrivingBody;
          if (controller.signal.aborted) disposeBody();
          return response;
        });
        const response = await interruptible(downloading),
          candidate = field(response, "Body");
        if (!(candidate instanceof Readable)) return fail();
        body = candidate;
        verifyObject(response, b, c);
        check();
        const bytes = Buffer.alloc(b.assetVersion.byteSize),
          hash = createHash("sha256"),
          iterator = body[Symbol.asyncIterator]();
        let size = 0;
        for (;;) {
          const next = await interruptible(iterator.next());
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array) || chunk.byteLength > bytes.length - size)
            return fail();
          bytes.set(chunk, size);
          hash.update(bytes.subarray(size, size + chunk.byteLength));
          size += chunk.byteLength;
        }
        if (size !== bytes.length || "sha256:" + hash.digest("hex") !== b.assetVersion.checksum)
          return fail();
        check();
        return Object.freeze({
          bytes,
          contentType: b.contentType,
          objectEvidence: Object.freeze({
            ...b.object,
            tenantReference: c.tenantReference,
            scope: c.scope,
            uploadSessionReference: b.session.uploadSessionId,
            assetReference: b.asset.assetId,
            assetVersionReference: b.assetVersion.assetVersionId,
            byteSize: size,
            checksum: b.assetVersion.checksum,
            kmsKeyArn: c.kmsKeyArn,
          }),
          scanEvidence: b.scan,
        });
      } catch {
        abort();
        return fail();
      } finally {
        clearTimeout(timer);
        if (signal instanceof AbortSignal) signal.removeEventListener("abort", abort);
        disposeBody();
      }
    },
  });
}
