import { performance } from "node:perf_hooks";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  createUploadSession,
  parseMediaChecksum,
  parseMediaInstant,
  type MediaChecksum,
  type UploadSession,
} from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import {
  parseS3QuarantineImageConfig,
  quarantineImageObjectNamePattern,
  type S3QuarantineImageConfig,
} from "./s3-quarantine-image-source.js";

export interface S3ImageUploadInput {
  readonly session: UploadSession;
  readonly key: string;
  readonly checksum: MediaChecksum;
}
export interface S3ImageUploadSdk {
  send(
    command: HeadObjectCommand,
    options: { readonly abortSignal: AbortSignal },
  ): Promise<unknown>;
}
export interface S3ImageUploadProviderOptions {
  readonly config: S3QuarantineImageConfig;
  readonly clock: { now(): string };
  readonly sdk?: S3ImageUploadSdk;
  readonly sign?: typeof createPresignedPost;
}
export class MediaUploadUnavailableError extends Error {
  readonly code = "MEDIA_UPLOAD_UNAVAILABLE";
  constructor() {
    super("Media upload is unavailable");
    this.name = "MediaUploadUnavailableError";
  }
}
const fail = (): never => {
  throw new MediaUploadUnavailableError();
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const maximumDurationMs = 30000;
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !("value" in descriptor)) return fail();
  return descriptor.value;
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
  for (const key of fields) field(value, key);
  return value as Record<string, unknown>;
}
function binding(input: unknown, config: S3QuarantineImageConfig) {
  const r = closed(copyMediaUploadStorageValue(input), ["session", "key", "checksum"]),
    session = createUploadSession(r.session as UploadSession),
    checksum = parseMediaChecksum(r.checksum),
    key = r.key;
  if (
    session.state !== "Pending" ||
    session.version !== 1 ||
    session.mediaKind !== "Image" ||
    !["image/jpeg", "image/png", "image/webp"].includes(session.declaredContentType) ||
    session.declaredByteSize > 10 * 1024 * 1024 ||
    !equal(session.scope, config.scope) ||
    typeof key !== "string" ||
    !key.startsWith(config.quarantinePrefix) ||
    !quarantineImageObjectNamePattern.test(key.slice(config.quarantinePrefix.length))
  )
    return fail();
  const metadata = Object.freeze({
    "bop-tenant-reference": config.tenantReference,
    "bop-brand-reference": config.scope.brandReference,
    "bop-store-reference": config.scope.storeReference ?? "",
    "bop-upload-session-reference": session.uploadSessionId,
    "bop-actor-reference": session.actorReference,
    "bop-purpose": session.purpose,
    "bop-owner-type": session.ownerType,
    "bop-owner-reference": session.ownerReference,
    "bop-classification": session.classification,
  });
  return Object.freeze({
    session,
    checksum,
    key,
    metadata,
    base64Checksum: Buffer.from(checksum.slice(7), "hex").toString("base64"),
  });
}
type BoundUpload = ReturnType<typeof binding>;
function head(
  response: unknown,
  input: BoundUpload,
  config: S3QuarantineImageConfig,
  expected?: { readonly versionId: string; readonly etag: string },
) {
  const versionId = field(response, "VersionId"),
    httpEtag = field(response, "ETag"),
    metadata = field(response, "Metadata"),
    checksum = field(response, "ChecksumSHA256");
  if (
    field(field(response, "$metadata"), "httpStatusCode") !== 200 ||
    typeof versionId !== "string" ||
    !/^[\x21-\x7e]{1,1024}$/u.test(versionId) ||
    versionId === "null" ||
    typeof httpEtag !== "string" ||
    !/^"[\x21\x23-\x5b\x5d-\x7e]{1,128}"$/u.test(httpEtag) ||
    field(response, "ContentLength") !== input.session.declaredByteSize ||
    field(response, "ContentType") !== input.session.declaredContentType ||
    field(response, "ChecksumType") !== "FULL_OBJECT" ||
    checksum !== input.base64Checksum ||
    field(response, "ServerSideEncryption") !== "aws:kms" ||
    field(response, "SSEKMSKeyId") !== config.kmsKeyArn ||
    field(response, "ContentEncoding") !== undefined ||
    field(response, "ContentRange") !== undefined ||
    field(response, "WebsiteRedirectLocation") !== undefined ||
    field(response, "DeleteMarker") === true
  )
    return fail();
  const etag = httpEtag.slice(1, -1);
  if (expected && (versionId !== expected.versionId || etag !== expected.etag)) return fail();
  for (const [key, value] of Object.entries(input.metadata))
    if (field(metadata, key) !== value) return fail();
  return Object.freeze({ versionId, etag });
}
function postFields(
  input: BoundUpload,
  config: S3QuarantineImageConfig,
): Readonly<Record<string, string>> {
  return Object.freeze({
    "Content-Type": input.session.declaredContentType,
    "x-amz-checksum-algorithm": "SHA256",
    "x-amz-checksum-sha256": input.base64Checksum,
    "x-amz-server-side-encryption": "aws:kms",
    "x-amz-server-side-encryption-aws-kms-key-id": config.kmsKeyArn,
    ...Object.fromEntries(
      Object.entries(input.metadata).map(([key, value]) => ["x-amz-meta-" + key, value]),
    ),
    success_action_status: "204",
  });
}
function signedPost(
  value: unknown,
  input: BoundUpload,
  config: S3QuarantineImageConfig,
  required: Readonly<Record<string, string>>,
  realStarted: number,
) {
  const r = closed(copyMediaUploadStorageValue(value), ["url", "fields"]),
    f = closed(r.fields, [
      ...Object.keys(required),
      "bucket",
      "key",
      "X-Amz-Algorithm",
      "X-Amz-Credential",
      "X-Amz-Date",
      "Policy",
      "X-Amz-Signature",
      ...(Object.hasOwn(r.fields as object, "X-Amz-Security-Token")
        ? ["X-Amz-Security-Token"]
        : []),
    ]);
  const fields: Record<string, string> = {};
  for (const [key, item] of Object.entries(f)) {
    if (typeof item !== "string" || item.length > 16384) return fail();
    fields[key] = item;
  }
  if (
    r.url !== "https://" + config.bucket + ".s3.ca-central-1.amazonaws.com/" ||
    fields.bucket !== config.bucket ||
    fields.key !== input.key ||
    fields["X-Amz-Algorithm"] !== "AWS4-HMAC-SHA256" ||
    !/^[a-f0-9]{64}$/u.test(fields["X-Amz-Signature"] ?? "") ||
    !/^\d{8}T\d{6}Z$/u.test(fields["X-Amz-Date"] ?? "")
  )
    return fail();
  const signingDate = fields["X-Amz-Date"] ?? "",
    credential = fields["X-Amz-Credential"] ?? "",
    credentialParts = credential.split("/");
  if (
    credentialParts.length !== 5 ||
    !/^[A-Za-z0-9]{1,128}$/u.test(credentialParts[0] ?? "") ||
    credentialParts[1] !== signingDate.slice(0, 8) ||
    credentialParts[2] !== config.region ||
    credentialParts[3] !== "s3" ||
    credentialParts[4] !== "aws4_request"
  )
    return fail();
  const signingAt = Date.parse(
    signingDate.slice(0, 4) +
      "-" +
      signingDate.slice(4, 6) +
      "-" +
      signingDate.slice(6, 8) +
      "T" +
      signingDate.slice(9, 11) +
      ":" +
      signingDate.slice(11, 13) +
      ":" +
      signingDate.slice(13, 15) +
      ".000Z",
  );
  if (!Number.isFinite(signingAt) || signingAt < realStarted - 1000 || signingAt > Date.now())
    return fail();
  for (const [key, value] of Object.entries(required)) if (fields[key] !== value) return fail();
  const encoded = fields.Policy;
  if (
    typeof encoded !== "string" ||
    encoded.length < 1 ||
    encoded.length > 16384 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) ||
    Buffer.from(encoded, "base64").toString("base64") !== encoded
  )
    return fail();
  const policy = closed(
      copyMediaUploadStorageValue(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))),
      ["expiration", "conditions"],
    ),
    // The owning AWS SDK emits policy timestamps without fractional seconds.
    expiresAt = parseMediaInstant(
      typeof policy.expiration === "string"
        ? policy.expiration.replace(/(?<!\.\d{3})Z$/u, ".000Z")
        : policy.expiration,
    );
  if (
    expiresAt > input.session.expiresAt ||
    Date.parse(expiresAt) <= Date.now() ||
    !Array.isArray(policy.conditions)
  )
    return fail();
  const expectedConditions: unknown[] = [
    ["content-length-range", input.session.declaredByteSize, input.session.declaredByteSize],
  ];
  for (const [key, value] of Object.entries(fields))
    if (key !== "Policy" && key !== "X-Amz-Signature") expectedConditions.push({ [key]: value });
  const actual = policy.conditions
      .map((condition: unknown) => canonicalizeRfc8785(condition))
      .sort(),
    expected = expectedConditions.map((condition) => canonicalizeRfc8785(condition)).sort();
  if (!equal(actual, expected)) return fail();
  return Object.freeze({ url: r.url, fields: Object.freeze(fields), expiresAt });
}

/** Private adapter: IAM/current Actor admission, one-time Session locking and
 * persisted locator ownership belong to the runtime/UoW. Signed form fields
 * are transient credentials and must never enter persistence or logs. */
export function createS3ImageUploadProvider(options: S3ImageUploadProviderOptions) {
  let config: S3QuarantineImageConfig,
    now: () => string,
    send: S3ImageUploadSdk["send"],
    sign: typeof createPresignedPost,
    client: S3Client;
  try {
    const r = closed(options, [
      "config",
      "clock",
      ...(Object.hasOwn(options, "sdk") ? ["sdk"] : []),
      ...(Object.hasOwn(options, "sign") ? ["sign"] : []),
    ]);
    config = parseS3QuarantineImageConfig(field(r, "config"));
    const clock = closed(field(r, "clock"), ["now"]),
      readClock = field(clock, "now");
    if (typeof readClock !== "function") return fail();
    now = (readClock as () => string).bind(clock);
    client = new S3Client({
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
    const sdk = field(r, "sdk"),
      signer = field(r, "sign");
    if (sdk !== undefined) {
      const method = field(closed(sdk, ["send"]), "send");
      if (typeof method !== "function") return fail();
      send = (method as S3ImageUploadSdk["send"]).bind(sdk);
    } else send = (command, request) => client.send(command, request);
    if (signer !== undefined && typeof signer !== "function") return fail();
    sign = signer === undefined ? createPresignedPost : (signer as typeof createPresignedPost);
  } catch {
    return fail();
  }
  async function operate<T>(
    input: S3ImageUploadInput,
    work: (
      b: BoundUpload,
      check: () => string,
      wait: <R>(value: Promise<R>) => Promise<R>,
      signal: AbortSignal,
    ) => Promise<T>,
  ): Promise<T> {
    const started = performance.now(),
      controller = new AbortController();
    let cancel = () => {
      /* The promise executor supplies the timeout rejection. */
    };
    const aborted = new Promise<never>((_, reject) => {
      cancel = () => {
        controller.abort();
        reject(new MediaUploadUnavailableError());
      };
    });
    let timer = setTimeout(cancel, maximumDurationMs);
    // Always attach a rejection handler before synchronous input validation can
    // fail; no timed-out credential/signing result is later returned to a caller.
    void aborted.catch(() => {
      /* The active wait consumes the bounded rejection. */
    });
    try {
      const observedAt = parseMediaInstant(now()),
        b = binding(input, config),
        deadline = Math.min(
          Date.parse(observedAt) + maximumDurationMs,
          Date.parse(b.session.expiresAt),
        );
      clearTimeout(timer);
      timer = setTimeout(
        cancel,
        Math.max(0, deadline - Date.parse(observedAt) - (performance.now() - started)),
      );
      let latest = observedAt;
      const check = () => {
        const current = parseMediaInstant(now());
        if (
          controller.signal.aborted ||
          current < latest ||
          current < b.session.createdAt ||
          Date.parse(current) >= deadline ||
          performance.now() - started >= maximumDurationMs
        ) {
          cancel();
          return fail();
        }
        latest = current;
        return current;
      };
      const wait = async <R>(operation: Promise<R>): Promise<R> => {
        const result = await Promise.race([operation, aborted]);
        check();
        return result;
      };
      check();
      const result = await work(b, check, wait, controller.signal);
      check();
      return result;
    } catch {
      controller.abort();
      return fail();
    } finally {
      clearTimeout(timer);
    }
  }
  return Object.freeze({
    signUpload(input: S3ImageUploadInput) {
      return operate(input, async (b, check, wait) => {
        const fields = postFields(b, config),
          realStarted = Date.now(),
          expires = Math.floor((Date.parse(b.session.expiresAt) - realStarted) / 1000);
        if (expires < 1 || expires > 900) return fail();
        const conditions: NonNullable<Parameters<typeof createPresignedPost>[1]["Conditions"]> = [
          ["content-length-range", b.session.declaredByteSize, b.session.declaredByteSize],
          { bucket: config.bucket },
          { key: b.key },
          ...Object.entries(fields).map(([key, value]) => ({ [key]: value })),
        ];
        const result = await wait(
          sign(client, {
            Bucket: config.bucket,
            Key: b.key,
            Conditions: conditions,
            Fields: { ...fields },
            Expires: expires,
          }),
        );
        const output = signedPost(result, b, config, fields, realStarted);
        check();
        return output;
      });
    },
    verifyUpload(input: S3ImageUploadInput) {
      return operate(input, async (b, check, wait, signal) => {
        const common = {
            Bucket: config.bucket,
            Key: b.key,
            ExpectedBucketOwner: config.accountId,
            ChecksumMode: "ENABLED" as const,
          },
          discovered = head(
            await wait(send(new HeadObjectCommand(common), { abortSignal: signal })),
            b,
            config,
          ),
          pinned = head(
            await wait(
              send(
                new HeadObjectCommand({
                  ...common,
                  VersionId: discovered.versionId,
                  IfMatch: '"' + discovered.etag + '"',
                }),
                { abortSignal: signal },
              ),
            ),
            b,
            config,
            discovered,
          );
        return Object.freeze({
          ...pinned,
          byteSize: b.session.declaredByteSize,
          checksum: b.checksum,
          contentType: b.session.declaredContentType,
          observedAt: check(),
        });
      });
    },
  });
}
