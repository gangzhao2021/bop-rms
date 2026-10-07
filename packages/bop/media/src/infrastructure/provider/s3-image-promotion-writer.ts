import { performance } from "node:perf_hooks";
import {
  CopyObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { canonicalizeRfc8785 } from "@bop/audit";
import { parseMediaInstant } from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import { processPublicImage } from "../processing/public-image-processor.js";
import {
  parseMediaImagePromotionPlan,
  mediaImagePromotionPlanDigest,
  parseMediaImagePromotionResult,
  type MediaImagePromotionPlan,
  type MediaImagePromotionResult,
} from "../processing/media-image-promotion.js";
import {
  createS3QuarantineImageSource,
  parseS3QuarantineImageConfig,
  type S3QuarantineImageConfig,
  type S3QuarantineImageReadInput,
} from "./s3-quarantine-image-source.js";

type Command =
  | HeadObjectCommand
  | GetObjectCommand
  | GetObjectTaggingCommand
  | CopyObjectCommand
  | PutObjectCommand;
export interface S3ImagePromotionSdk {
  send(command: Command, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
}
export interface S3ImagePromotionWriterOptions {
  readonly quarantineConfig: S3QuarantineImageConfig;
  readonly clock: { now(): string };
  readonly sdk?: S3ImagePromotionSdk;
}
class MediaImagePromotionUnavailableError extends Error {
  readonly code = "MEDIA_IMAGE_PROMOTION_UNAVAILABLE";
  constructor() {
    super("Media image promotion is unavailable");
    this.name = "MediaImagePromotionUnavailableError";
  }
}
const fail = (): never => {
  throw new MediaImagePromotionUnavailableError();
};
const maximumDurationMs = 180000;
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d) return undefined;
  if (!d.enumerable || !("value" in d)) return fail();
  return d.value;
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of fields) result[key] = field(value, key);
  return result;
}
function version(value: unknown): string {
  if (typeof value !== "string" || !/^[\x21-\x7e]{1,1024}$/u.test(value) || value === "null")
    return fail();
  return value;
}
function etag(value: unknown): string {
  if (typeof value !== "string" || !/^"[\x21\x23-\x5b\x5d-\x7e]{1,128}"$/u.test(value))
    return fail();
  return value.slice(1, -1);
}
function status(value: unknown): unknown {
  return field(field(value, "$metadata"), "httpStatusCode");
}
function absent(error: unknown): boolean {
  try {
    return (
      status(error) === 404 && ["NotFound", "NoSuchKey"].includes(String(field(error, "name")))
    );
  } catch {
    return false;
  }
}
const base64 = (checksum: string) => Buffer.from(checksum.slice(7), "hex").toString("base64");
interface ExpectedObject {
  readonly byteSize: number;
  readonly checksum: string;
  readonly contentType: string;
  readonly kmsKeyArn: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly contentDisposition?: "attachment";
}
function verifiedHead(
  value: unknown,
  expected: ExpectedObject,
  pinned?: { readonly versionId: string; readonly etag: string },
) {
  const versionId = version(field(value, "VersionId")),
    actualEtag = etag(field(value, "ETag"));
  if (
    status(value) !== 200 ||
    field(value, "ChecksumType") !== "FULL_OBJECT" ||
    field(value, "ChecksumSHA256") !== base64(expected.checksum) ||
    field(value, "ContentLength") !== expected.byteSize ||
    field(value, "ContentType") !== expected.contentType ||
    field(value, "ServerSideEncryption") !== "aws:kms" ||
    field(value, "SSEKMSKeyId") !== expected.kmsKeyArn ||
    field(value, "DeleteMarker") === true ||
    field(value, "ContentRange") !== undefined ||
    field(value, "ContentEncoding") !== undefined ||
    field(value, "WebsiteRedirectLocation") !== undefined ||
    (expected.contentDisposition !== undefined &&
      field(value, "ContentDisposition") !== expected.contentDisposition) ||
    !equal(copyMediaUploadStorageValue(field(value, "Metadata")), expected.metadata) ||
    (pinned && (versionId !== pinned.versionId || actualEtag !== pinned.etag))
  )
    return fail();
  return Object.freeze({ versionId, etag: actualEtag });
}
function cleanTags(value: unknown, expectedVersion: string): void {
  const tags = copyMediaUploadStorageValue(field(value, "TagSet"));
  if (
    status(value) !== 200 ||
    field(value, "VersionId") !== expectedVersion ||
    !Array.isArray(tags) ||
    tags.length > 10
  )
    return fail();
  const keys = new Set<string>();
  let clean = false;
  for (const item of tags) {
    const tag = closed(item, ["Key", "Value"]);
    if (
      typeof tag.Key !== "string" ||
      tag.Key.length < 1 ||
      tag.Key.length > 128 ||
      keys.has(tag.Key) ||
      typeof tag.Value !== "string" ||
      tag.Value.length > 256
    )
      return fail();
    keys.add(tag.Key);
    if (tag.Key === "GuardDutyMalwareScanStatus") {
      if (tag.Value !== "NO_THREATS_FOUND") return fail();
      clean = true;
    }
  }
  if (!clean) return fail();
}

/** Private Provider pipeline only. The caller owns durable plans, trusted scan
 * ingress, System authority and the final database CAS/Audit transaction. A
 * verified S3 result alone does not promote a Media Asset or grant access. */
export function createS3ImagePromotionWriter(options: S3ImagePromotionWriterOptions) {
  let config: S3QuarantineImageConfig, now: () => string, send: S3ImagePromotionSdk["send"];
  let ownedClient: S3Client | undefined,
    writerClosed = false;
  const activeControllers = new Set<AbortController>();
  try {
    const r = closed(options, [
        "quarantineConfig",
        "clock",
        ...(Object.hasOwn(options, "sdk") ? ["sdk"] : []),
      ]),
      clock = closed(r.clock, ["now"]);
    config = parseS3QuarantineImageConfig(r.quarantineConfig);
    if (typeof clock.now !== "function") return fail();
    now = (clock.now as () => string).bind(r.clock);
    if (r.sdk !== undefined) {
      const method = field(r.sdk, "send");
      if (typeof method !== "function") return fail();
      send = (method as S3ImagePromotionSdk["send"]).bind(r.sdk);
    } else {
      const client = (ownedClient = new S3Client({
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
      }));
      send = (command, request) => {
        if (command instanceof HeadObjectCommand) return client.send(command, request);
        if (command instanceof GetObjectCommand) return client.send(command, request);
        if (command instanceof GetObjectTaggingCommand) return client.send(command, request);
        if (command instanceof CopyObjectCommand) return client.send(command, request);
        return client.send(command, request);
      };
    }
  } catch {
    return fail();
  }
  const reader = createS3QuarantineImageSource({
    config,
    sdk: { send: (command, request) => send(command, request) },
  });
  return Object.freeze({
    close() {
      if (writerClosed) return;
      writerClosed = true;
      for (const controller of activeControllers) controller.abort();
      ownedClient?.destroy();
    },
    async process(
      input: {
        readonly source: S3QuarantineImageReadInput;
        readonly plan: MediaImagePromotionPlan;
      },
      signal?: AbortSignal,
    ): Promise<MediaImagePromotionResult> {
      if (writerClosed) return fail();
      const started = performance.now(),
        controller = new AbortController(),
        abort = () => controller.abort(),
        timer = setTimeout(abort, maximumDurationMs);
      activeControllers.add(controller);
      try {
        if (signal !== undefined && !(signal instanceof AbortSignal)) return fail();
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
        const r = closed(copyMediaUploadStorageValue(input), ["source", "plan"]),
          source = r.source as S3QuarantineImageReadInput,
          plan = parseMediaImagePromotionPlan(r.plan),
          planDigest = mediaImagePromotionPlanDigest(plan),
          observedAt = parseMediaInstant(now()),
          deadline = Date.parse(observedAt) + maximumDurationMs;
        let latest = observedAt;
        const check = () => {
          const at = parseMediaInstant(now());
          if (
            controller.signal.aborted ||
            performance.now() - started >= maximumDurationMs ||
            at < latest ||
            Date.parse(at) >= deadline
          ) {
            abort();
            return fail();
          }
          latest = at;
          return at;
        };
        const wait = async <T>(work: () => Promise<T>): Promise<T> => {
          check();
          let rejectAbort = () => {
            /* Installed by the promise executor. */
          };
          const cancelled = new Promise<never>((_, reject) => {
            rejectAbort = () => reject(new MediaImagePromotionUnavailableError());
            controller.signal.addEventListener("abort", rejectAbort, { once: true });
            if (controller.signal.aborted) rejectAbort();
          });
          try {
            const result = await Promise.race([work(), cancelled]);
            check();
            return result;
          } finally {
            controller.signal.removeEventListener("abort", rejectAbort);
          }
        };
        const request = (command: Command) =>
          wait(() => send(command, { abortSignal: controller.signal }));
        if (
          plan.tenantReference !== config.tenantReference ||
          source.tenantReference !== config.tenantReference ||
          !equal(plan.scope, config.scope) ||
          !equal(source.asset.scope, config.scope) ||
          plan.assetReference !== source.asset.assetId ||
          plan.sourceAssetVersionReference !== source.assetVersion.assetVersionId ||
          plan.destination.accountId !== config.accountId ||
          (plan.destination.bucket === config.bucket &&
            (plan.destination.cleanPrefix.startsWith(config.quarantinePrefix) ||
              config.quarantinePrefix.startsWith(plan.destination.cleanPrefix)))
        )
          return fail();
        // The reader verifies the original v1 receipt, exact version, scan event,
        // current clean tag, encryption, metadata and the downloaded SHA256.
        const read = await wait(() => reader.read(source, controller.signal));
        const processed = await wait(() =>
          processPublicImage({ bytes: read.bytes, declaredContentType: read.contentType }),
        );
        if (
          processed.profile !== plan.profile ||
          processed.source.checksum !== read.objectEvidence.checksum ||
          processed.source.byteSize !== read.objectEvidence.byteSize ||
          processed.source.contentType !== read.contentType
        )
          return fail();
        const sourceMetadata = Object.freeze({
          "bop-tenant-reference": config.tenantReference,
          "bop-brand-reference": config.scope.brandReference,
          "bop-store-reference": config.scope.storeReference ?? "",
          "bop-upload-session-reference": source.session.uploadSessionId,
          "bop-actor-reference": source.session.actorReference,
          "bop-purpose": source.session.purpose,
          "bop-owner-type": source.session.ownerType,
          "bop-owner-reference": source.session.ownerReference,
          "bop-classification": source.session.classification,
        });
        const freshSource = async () => {
          const common = {
            Bucket: config.bucket,
            Key: source.object.key,
            VersionId: source.object.versionId,
            ExpectedBucketOwner: config.accountId,
          };
          verifiedHead(
            await request(
              new HeadObjectCommand({
                ...common,
                ChecksumMode: "ENABLED",
                IfMatch: '"' + source.object.etag + '"',
              }),
            ),
            {
              byteSize: source.assetVersion.byteSize,
              contentType: source.assetVersion.contentType,
              checksum: source.assetVersion.checksum,
              kmsKeyArn: config.kmsKeyArn,
              metadata: sourceMetadata,
            },
            source.object,
          );
          cleanTags(await request(new GetObjectTaggingCommand(common)), source.object.versionId);
        };
        const metadata = (kind: string, planned: MediaImagePromotionPlan["original"]) =>
          Object.freeze({
            "bop-tenant-reference": plan.tenantReference,
            "bop-brand-reference": plan.scope.brandReference,
            "bop-store-reference": plan.scope.storeReference ?? "",
            "bop-operation-reference": plan.operationReference,
            "bop-asset-reference": plan.assetReference,
            "bop-source-asset-version-reference": plan.sourceAssetVersionReference,
            "bop-source-binding-digest": plan.sourceBindingDigest,
            "bop-plan-digest": planDigest,
            "bop-processing-profile": plan.profile,
            "bop-output-kind": kind,
            "bop-object-evidence-reference": planned.objectEvidenceReference,
            "bop-provider-object-version": planned.providerObjectVersion,
          });
        const destination = plan.destination;
        const pin = async (
          key: string,
          expected: ExpectedObject,
          candidate: { readonly versionId: string; readonly etag: string },
        ) =>
          verifiedHead(
            await request(
              new HeadObjectCommand({
                Bucket: destination.bucket,
                Key: key,
                VersionId: candidate.versionId,
                IfMatch: '"' + candidate.etag + '"',
                ExpectedBucketOwner: destination.accountId,
                ChecksumMode: "ENABLED",
              }),
            ),
            expected,
            candidate,
          );
        const probe = async (key: string, expected: ExpectedObject) => {
          let response: unknown;
          try {
            response = await request(
              new HeadObjectCommand({
                Bucket: destination.bucket,
                Key: key,
                ExpectedBucketOwner: destination.accountId,
                ChecksumMode: "ENABLED",
              }),
            );
          } catch (error) {
            check();
            if (absent(error)) return null;
            throw error;
          }
          return pin(key, expected, verifiedHead(response, expected));
        };
        const writeObject = async (
          planned: MediaImagePromotionPlan["original"],
          kind: string,
          content: {
            readonly byteSize: number;
            readonly checksum: string;
            readonly contentType: string;
            readonly bytes?: Uint8Array;
          },
        ) => {
          const expected: ExpectedObject = {
            byteSize: content.byteSize,
            checksum: content.checksum,
            contentType: content.contentType,
            kmsKeyArn: destination.kmsKeyArn,
            metadata: metadata(kind, planned),
            ...(kind === "PrivateOriginal" ? { contentDisposition: "attachment" as const } : {}),
          };
          let found = await probe(planned.key, expected);
          if (!found) {
            const common = {
              Bucket: destination.bucket,
              Key: planned.key,
              ExpectedBucketOwner: destination.accountId,
              ServerSideEncryption: "aws:kms" as const,
              SSEKMSKeyId: destination.kmsKeyArn,
              ChecksumAlgorithm: "SHA256" as const,
              ContentType: content.contentType,
              Metadata: { ...expected.metadata },
            };
            if (kind === "PrivateOriginal") await freshSource();
            let response: unknown;
            try {
              if (kind === "PrivateOriginal") {
                const copySource =
                  config.bucket +
                  "/" +
                  source.object.key.split("/").map(encodeURIComponent).join("/") +
                  "?versionId=" +
                  encodeURIComponent(source.object.versionId);
                response = await request(
                  new CopyObjectCommand({
                    ...common,
                    CopySource: copySource,
                    CopySourceIfMatch: '"' + source.object.etag + '"',
                    ExpectedSourceBucketOwner: config.accountId,
                    MetadataDirective: "REPLACE",
                    TaggingDirective: "REPLACE",
                    Tagging: "",
                    ContentDisposition: "attachment",
                  }),
                );
              } else {
                if (!content.bytes || content.bytes.byteLength !== content.byteSize) return fail();
                response = await request(
                  new PutObjectCommand({
                    ...common,
                    Body: content.bytes,
                    ContentLength: content.byteSize,
                    ChecksumSHA256: base64(content.checksum),
                    IfNoneMatch: "*",
                  }),
                );
              }
            } catch {
              // An unknown result or concurrent conditional-write conflict is
              // resolved only by exact existing metadata + full checksum + pin.
              // Never retry blindly, allocate another key or delete an object.
              check();
              found = await probe(planned.key, expected);
              if (!found) return fail();
            }
            if (!found) {
              const copied = kind === "PrivateOriginal",
                body = copied ? field(response, "CopyObjectResult") : response;
              if (
                status(response) !== 200 ||
                field(response, "ServerSideEncryption") !== "aws:kms" ||
                field(response, "SSEKMSKeyId") !== destination.kmsKeyArn ||
                field(body, "ChecksumSHA256") !== base64(content.checksum) ||
                (copied && field(response, "CopySourceVersionId") !== source.object.versionId)
              )
                return fail();
              found = await pin(planned.key, expected, {
                versionId: version(field(response, "VersionId")),
                etag: etag(field(body, "ETag")),
              });
            }
          }
          return Object.freeze({
            ...planned,
            bucket: destination.bucket,
            ...found,
            contentType: content.contentType,
            byteSize: content.byteSize,
            checksum: content.checksum,
          });
        };
        const original = await writeObject(plan.original, "PrivateOriginal", processed.source),
          renditions = [];
        for (const planned of plan.renditions) {
          const matches = processed.renditions.filter(
            (item) => item.width === planned.width && item.contentType === planned.contentType,
          );
          const selected = matches[0];
          if (matches.length !== 1 || !selected) return fail();
          renditions.push({
            ...(await writeObject(planned, planned.contentType + ":" + planned.width, selected)),
            width: selected.width,
            height: selected.height,
          });
        }
        await freshSource();
        const result = parseMediaImagePromotionResult(
          {
            profile: "PUBLIC_IMAGE_RESULT_V1",
            operationReference: plan.operationReference,
            planDigest,
            sourceEvidence: read.objectEvidence,
            scanEvidence: read.scanEvidence,
            original,
            renditions,
            completedAt: check(),
          },
          plan,
          source,
        );
        check();
        return result;
      } catch {
        abort();
        return fail();
      } finally {
        clearTimeout(timer);
        if (signal instanceof AbortSignal) signal.removeEventListener("abort", abort);
        activeControllers.delete(controller);
      }
    },
  });
}
