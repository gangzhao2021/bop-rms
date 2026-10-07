import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import { GetObjectCommand, GetObjectTaggingCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
} from "../contracts/media.js";
import {
  createS3QuarantineImageSource,
  type S3QuarantineImageReadInput,
  type S3QuarantineImageSdk,
} from "../infrastructure/provider/s3-quarantine-image-source.js";
import { processPublicImage } from "../infrastructure/processing/public-image-processor.js";

const sdkDefaults = vi.hoisted(() => ({ configurations: [] as unknown[], send: vi.fn() }));
vi.mock("@aws-sdk/client-s3", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    constructor(config: unknown) {
      sdkDefaults.configurations.push(config);
    }
    send = sdkDefaults.send;
  },
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  sdkDefaults.configurations.length = 0;
});
const id = (n: number) => "019a2421-0019-7000-8000-" + n.toString(16).padStart(12, "0");
const unavailable = expect.objectContaining({
  code: "MEDIA_QUARANTINE_UNAVAILABLE",
  message: "Media quarantine is unavailable",
});
function fixture(
  contentType = "image/png",
  storeReference: string | null = id(3),
  providedBytes?: Buffer,
) {
  const bytes =
      providedBytes ??
      Buffer.from("controlled opaque image input; decoding is a separate actual processor"),
    scope = createMediaScope({
      kind: storeReference === null ? "Brand" : "Store",
      brandReference: id(2),
      storeReference,
    } as Parameters<typeof createMediaScope>[0]),
    config = {
      tenantReference: id(1),
      scope,
      region: "ca-central-1" as const,
      accountId: "111122223333",
      bucket: "synthetic-media-quarantine",
      quarantinePrefix: "quarantine/",
      kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      protectionPlanArn:
        "arn:aws:guardduty:ca-central-1:111122223333:malware-protection-plan/synthetic123",
    },
    session = createUploadSession({
      uploadSessionId: id(4),
      grantReference: id(5),
      actorReference: id(6),
      purpose: "PRODUCT_IMAGE",
      scope,
      mediaKind: "Image",
      declaredContentType: contentType,
      declaredByteSize: bytes.length,
      ownerType: "PRODUCT",
      ownerReference: id(7),
      classification: "Internal",
      state: "Finalized",
      version: 2,
      createdAt: "2026-10-03T12:00:00.000Z",
      expiresAt: "2026-10-03T12:15:00.000Z",
    } as Parameters<typeof createUploadSession>[0]),
    asset = createMediaAsset({
      assetId: id(8),
      purpose: session.purpose,
      scope,
      mediaKind: "Image",
      ownerType: session.ownerType,
      ownerReference: session.ownerReference,
      classification: "Internal",
      currentVersionReference: null,
      version: 1,
    } as Parameters<typeof createMediaAsset>[0]),
    checksum = "sha256:" + createHash("sha256").update(bytes).digest("hex"),
    assetVersion = createMediaAssetVersion({
      assetVersionId: id(9),
      assetId: asset.assetId,
      version: 1,
      objectEvidenceReference: id(10),
      providerObjectVersion: id(11),
      byteSize: bytes.length,
      checksum,
      contentType,
      checkState: "Quarantined",
      readinessState: "Pending",
      createdAt: "2026-10-03T12:00:01.000Z",
    } as Parameters<typeof createMediaAssetVersion>[0]),
    object = {
      bucket: config.bucket,
      key: "quarantine/" + "a".repeat(64),
      versionId: "3/L4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY.M",
      etag: "opaque-multipart-etag-2",
      objectEvidenceReference: assetVersion.objectEvidenceReference,
      providerObjectVersion: assetVersion.providerObjectVersion,
    },
    scanEvent = {
      version: "0",
      id: "72c7d362-737a-6dce-fc78-9e27a0171419",
      "detail-type": "GuardDuty Malware Protection Object Scan Result",
      source: "aws.guardduty",
      account: config.accountId,
      time: "2026-10-03T12:00:00Z",
      region: config.region,
      resources: [config.protectionPlanArn],
      detail: {
        schemaVersion: "1.0",
        scanStatus: "COMPLETED",
        resourceType: "S3_OBJECT",
        s3ObjectDetails: {
          bucketName: object.bucket,
          objectKey: object.key,
          eTag: object.etag,
          versionId: object.versionId,
          s3Throttled: false,
        },
        scanResultDetails: {
          scanResultStatus: "NO_THREATS_FOUND",
          threats: null,
          statusReasons: null,
        },
      },
    },
    input = {
      tenantReference: config.tenantReference,
      session,
      asset,
      assetVersion,
      object,
      scanEvent,
    },
    metadata = {
      "bop-tenant-reference": config.tenantReference,
      "bop-brand-reference": scope.brandReference,
      "bop-store-reference": scope.storeReference ?? "",
      "bop-upload-session-reference": session.uploadSessionId,
      "bop-actor-reference": session.actorReference,
      "bop-purpose": session.purpose,
      "bop-owner-type": session.ownerType,
      "bop-owner-reference": session.ownerReference,
      "bop-classification": session.classification,
    },
    headers = {
      VersionId: object.versionId,
      ETag: '"' + object.etag + '"',
      ContentLength: bytes.length,
      ContentType: contentType,
      ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
      ChecksumType: "FULL_OBJECT",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: config.kmsKeyArn,
      Metadata: metadata,
    };
  return { config, input, bytes, headers };
}
function harness(
  contentType = "image/png",
  storeReference: string | null = id(3),
  providedBytes?: Buffer,
) {
  const f = fixture(contentType, storeReference, providedBytes),
    commands: Parameters<S3QuarantineImageSdk["send"]>[0][] = [],
    signals: AbortSignal[] = [];
  const state: {
    head: Record<string, unknown>;
    tags: Record<string, unknown>;
    get: Record<string, unknown>;
    beforeSend?: (
      command: Parameters<S3QuarantineImageSdk["send"]>[0],
      signal: AbortSignal,
    ) => Promise<void>;
  } = {
    head: structuredClone(f.headers),
    tags: {
      VersionId: f.input.object.versionId,
      TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" }],
    },
    get: {
      ...structuredClone(f.headers),
      Body: Readable.from([f.bytes.subarray(0, 8), f.bytes.subarray(8)]),
    },
  };
  const sdk: S3QuarantineImageSdk = {
    async send(command, options) {
      commands.push(command);
      signals.push(options.abortSignal);
      await state.beforeSend?.(command, options.abortSignal);
      return command instanceof HeadObjectCommand
        ? state.head
        : command instanceof GetObjectTaggingCommand
          ? state.tags
          : state.get;
    },
  };
  const source = createS3QuarantineImageSource({ config: f.config, sdk });
  // Deliberately exercise the runtime unknown boundary without widening the
  // production typed contract or treating controlled provider data as AWS proof.
  const read = (input: unknown = f.input, signal?: AbortSignal) =>
    source.read(input as S3QuarantineImageReadInput, signal);
  return { ...f, source, read, sdk, state, commands, signals };
}
it.each(["image/jpeg", "image/png", "image/webp"])(
  "reads exact %s quarantine bytes with real SDK commands and independent checksum verification",
  async (type) => {
    const h = harness(type),
      result = await h.read(),
      common = {
        Bucket: h.config.bucket,
        Key: h.input.object.key,
        VersionId: h.input.object.versionId,
        ExpectedBucketOwner: h.config.accountId,
      };
    expect(result.bytes).toEqual(h.bytes);
    expect(result.contentType).toBe(type);
    expect(h.commands.map((command) => command.constructor)).toEqual([
      HeadObjectCommand,
      GetObjectTaggingCommand,
      GetObjectCommand,
    ]);
    expect(h.commands.map((command) => command.input)).toEqual([
      { ...common, ChecksumMode: "ENABLED" },
      common,
      { ...common, ChecksumMode: "ENABLED", IfMatch: '"' + h.input.object.etag + '"' },
    ]);
    expect(new Set(h.signals).size).toBe(1);
    expect(result.objectEvidence).toMatchObject({
      objectEvidenceReference: h.input.assetVersion.objectEvidenceReference,
      providerObjectVersion: h.input.assetVersion.providerObjectVersion,
      checksum: h.input.assetVersion.checksum,
      assetVersionReference: h.input.assetVersion.assetVersionId,
    });
    expect(result.scanEvidence.result).toBe("NO_THREATS_FOUND");
    expect(result).not.toHaveProperty("readinessState");
    expect(result).not.toHaveProperty("currentVersionReference");
    expect((h.state.get.Body as Readable).destroyed).toBe(true);
  },
);
it("accepts Brand metadata and a throttled completed clean scan without pretending the input is decoded", async () => {
  const h = harness("image/png", null);
  h.input.scanEvent.detail.s3ObjectDetails.s3Throttled = true;
  const result = await h.read();
  expect(result.scanEvidence.s3Throttled).toBe(true);
  expect(result.bytes).toEqual(h.bytes);
});
it("passes an actual small PNG through the controlled SDK stream and real source into the real six-rendition processor", async () => {
  const bytes = await sharp({
      create: {
        width: 80,
        height: 40,
        channels: 4,
        background: { r: 40, g: 80, b: 120, alpha: 0.8 },
      },
    })
      .png()
      .toBuffer(),
    h = harness("image/png", id(3), bytes),
    original = await h.read(),
    processed = await processPublicImage({
      bytes: original.bytes,
      declaredContentType: original.contentType,
    });
  expect(processed.source).toEqual({
    contentType: "image/png",
    width: 80,
    height: 40,
    byteSize: original.objectEvidence.byteSize,
    checksum: original.objectEvidence.checksum,
  });
  expect(processed.renditions.map((item) => [item.contentType, item.width])).toEqual([
    ["image/jpeg", 320],
    ["image/webp", 320],
    ["image/jpeg", 640],
    ["image/webp", 640],
    ["image/jpeg", 1280],
    ["image/webp", 1280],
  ]);
  expect(h.commands).toHaveLength(3);
  expect(processed).not.toHaveProperty("readinessState");
});
it.each([
  "source",
  "type",
  "schema",
  "status",
  "result",
  "threats",
  "reasons",
  "account",
  "region",
  "plan",
  "bucket",
  "key",
  "version",
  "etag",
  "extra",
])("refuses a mismatched or non-clean %s GuardDuty event before provider access", async (fault) => {
  const h = harness(),
    e = h.input.scanEvent;
  const changed = {
    ...e,
    ...(fault === "source" ? { source: "custom.caller" } : {}),
    ...(fault === "type"
      ? { "detail-type": "GuardDuty Malware Protection Post Scan Action Failed" }
      : {}),
    ...(fault === "account" ? { account: "999999999999" } : {}),
    ...(fault === "region" ? { region: "us-east-1" } : {}),
    ...(fault === "plan" ? { resources: [e.resources[0], "another-plan"] } : {}),
    ...(fault === "extra" ? { clean: true } : {}),
    detail: {
      ...e.detail,
      ...(fault === "schema" ? { schemaVersion: "2.0" } : {}),
      ...(fault === "status" ? { scanStatus: "SKIPPED" } : {}),
      s3ObjectDetails: {
        ...e.detail.s3ObjectDetails,
        ...(fault === "bucket" ? { bucketName: "foreign-bucket" } : {}),
        ...(fault === "key" ? { objectKey: "quarantine/" + "b".repeat(64) } : {}),
        ...(fault === "version" ? { versionId: "changed-version" } : {}),
        ...(fault === "etag" ? { eTag: "changed-etag" } : {}),
      },
      scanResultDetails: {
        ...e.detail.scanResultDetails,
        ...(fault === "result" ? { scanResultStatus: "THREATS_FOUND" } : {}),
        ...(fault === "threats" ? { threats: [] } : {}),
        ...(fault === "reasons" ? { statusReasons: ["ACCESS_DENIED"] } : {}),
      },
    },
  };
  await expect(h.read({ ...h.input, scanEvent: changed })).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(0);
});
it.each([
  "tenant",
  "store",
  "session",
  "logical-evidence",
  "logical-version",
  "arbitrary-key",
  "url",
  "null-version",
  "ready",
  "oversize",
  "type",
])("rejects %s stored bindings without treating event JSON as authority", async (fault) => {
  const h = harness(),
    input = {
      ...h.input,
      ...(fault === "tenant" ? { tenantReference: id(99) } : {}),
      session: {
        ...h.input.session,
        ...(fault === "session" ? { ownerReference: id(99) } : {}),
        ...(fault === "oversize" ? { declaredByteSize: 10 * 1024 * 1024 + 1 } : {}),
        ...(fault === "type" ? { declaredContentType: "image/svg+xml" } : {}),
      },
      asset: {
        ...h.input.asset,
        ...(fault === "store" ? { scope: { ...h.input.asset.scope, storeReference: id(99) } } : {}),
      },
      assetVersion: {
        ...h.input.assetVersion,
        ...(fault === "ready" ? { readinessState: "Ready", checkState: "Clean" } : {}),
        ...(fault === "oversize" ? { byteSize: 10 * 1024 * 1024 + 1 } : {}),
        ...(fault === "type" ? { contentType: "image/svg+xml" } : {}),
      },
      object: {
        ...h.input.object,
        ...(fault === "logical-evidence" ? { objectEvidenceReference: id(99) } : {}),
        ...(fault === "logical-version" ? { providerObjectVersion: id(99) } : {}),
        ...(fault === "arbitrary-key" ? { key: "quarantine/a-person-original-filename.png" } : {}),
        ...(fault === "url" ? { key: "https://attacker.invalid/object" } : {}),
        ...(fault === "null-version" ? { versionId: "null" } : {}),
      },
    };
  await expect(h.read(input)).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(0);
});
it.each([
  "version",
  "etag",
  "checksum",
  "composite",
  "missing-checksum",
  "kms",
  "encryption",
  "length",
  "type",
  "metadata",
  "encoded",
  "range",
])("refuses a %s Head response and does not continue to tags or bytes", async (fault) => {
  const h = harness(),
    changes: Record<string, unknown> = {
      version: { VersionId: "changed" },
      etag: { ETag: '"changed"' },
      checksum: { ChecksumSHA256: Buffer.alloc(32).toString("base64") },
      composite: { ChecksumType: "COMPOSITE" },
      "missing-checksum": { ChecksumSHA256: undefined },
      kms: { SSEKMSKeyId: h.config.kmsKeyArn + "x" },
      encryption: { ServerSideEncryption: "AES256" },
      length: { ContentLength: h.bytes.length + 1 },
      type: { ContentType: "image/jpeg" },
      metadata: { Metadata: { ...h.headers.Metadata, "bop-tenant-reference": id(99) } },
      encoded: { ContentEncoding: "gzip" },
      range: { ContentRange: "bytes 0-1/100" },
    };
  h.state.head = { ...h.state.head, ...(changes[fault] as object) };
  await expect(h.read()).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(1);
});
it.each(["absent", "unknown", "denied", "duplicate", "version"])(
  "requires a fresh exact GuardDuty %s tag response",
  async (fault) => {
    const h = harness();
    h.state.tags =
      fault === "version"
        ? { ...h.state.tags, VersionId: "other" }
        : {
            ...h.state.tags,
            TagSet:
              fault === "absent"
                ? []
                : fault === "duplicate"
                  ? [
                      { Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" },
                      { Key: "GuardDutyMalwareScanStatus", Value: "NO_THREATS_FOUND" },
                    ]
                  : [
                      {
                        Key: "GuardDutyMalwareScanStatus",
                        Value: fault === "denied" ? "ACCESS_DENIED" : "NEW_UNKNOWN_RESULT",
                      },
                    ],
          };
    await expect(h.read()).rejects.toThrow(unavailable);
    expect(h.commands).toHaveLength(2);
  },
);
it.each([
  "changed-version",
  "changed-kms",
  "changed-metadata",
  "short",
  "overlong",
  "wrong-bytes",
  "string-chunk",
  "stream-error",
])("rechecks downloaded metadata and bounded bytes for %s", async (fault) => {
  const h = harness();
  if (fault === "changed-version") h.state.get.VersionId = "changed";
  if (fault === "changed-kms") h.state.get.SSEKMSKeyId = "different-key";
  if (fault === "changed-metadata")
    h.state.get.Metadata = { ...h.headers.Metadata, "bop-actor-reference": id(99) };
  if (fault === "short") h.state.get.Body = Readable.from([h.bytes.subarray(1)]);
  if (fault === "overlong") h.state.get.Body = Readable.from([h.bytes, Buffer.from([0])]);
  if (fault === "wrong-bytes") h.state.get.Body = Readable.from([Buffer.alloc(h.bytes.length)]);
  if (fault === "string-chunk") h.state.get.Body = Readable.from(["not binary"]);
  if (fault === "stream-error")
    h.state.get.Body = new Readable({
      read() {
        this.destroy(new Error("private provider failure"));
      },
    });
  await expect(h.read()).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(3);
  expect((h.state.get.Body as Readable).destroyed).toBe(true);
});
it("captures config, original binding and SDK method and never invokes an input getter", async () => {
  const h = harness(),
    getter = vi.fn(() => h.input.object),
    bad = { ...h.input };
  Object.defineProperty(bad, "object", { enumerable: true, get: getter });
  await expect(h.read(bad)).rejects.toThrow(unavailable);
  expect(getter).not.toHaveBeenCalled();
  const originalKey = h.input.object.key;
  h.config.bucket = "changed-config";
  h.sdk.send = async () => {
    throw Error("replaced SDK");
  };
  h.state.beforeSend = async () => {
    h.input.object.key = "changed-after-capture";
  };
  const result = await h.read();
  expect(result.objectEvidence.key).toBe(originalKey);
  expect(result.objectEvidence.bucket).toBe("synthetic-media-quarantine");
});
it("uses only the fixed regional default SDK endpoint even when endpoint environment variables are set", () => {
  const f = fixture();
  vi.stubEnv("AWS_ENDPOINT_URL", "https://untrusted.invalid");
  vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:9999");
  createS3QuarantineImageSource({ config: f.config });
  expect(sdkDefaults.configurations).toEqual([
    expect.objectContaining({
      region: "ca-central-1",
      endpoint: "https://s3.ca-central-1.amazonaws.com",
      useArnRegion: false,
      followRegionRedirects: false,
      disableMultiregionAccessPoints: true,
      useGlobalEndpoint: false,
      useAccelerateEndpoint: false,
      maxAttempts: 1,
    }),
  ]);
  expect(sdkDefaults.send).not.toHaveBeenCalled();
  expect(() =>
    createS3QuarantineImageSource({
      config: { ...f.config, endpoint: "https://untrusted.invalid" },
    } as Parameters<typeof createS3QuarantineImageSource>[0]),
  ).toThrow(unavailable);
});
it.each(["head", "stream"])(
  "aborts a stalled %s at the same original 30-second deadline and disposes the body",
  async (stage) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const h = harness();
    if (stage === "head")
      h.state.beforeSend = async () => {
        await new Promise(() => {
          /* Controlled transport deliberately never settles or handles abort. */
        });
      };
    else
      h.state.get.Body = new Readable({
        read() {
          /* Controlled stream remains idle until its owner destroys it. */
        },
      });
    const pending = expect(h.read()).rejects.toThrow(unavailable);
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(h.signals.every((signal) => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    if (stage === "stream") expect((h.state.get.Body as Readable).destroyed).toBe(true);
  },
);
it("shares the original deadline across SDK stages instead of granting each call another 30 seconds", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const h = harness();
  h.state.beforeSend = async () => {
    await new Promise((resolve) => setTimeout(resolve, 12000));
  };
  const pending = expect(h.read()).rejects.toThrow(unavailable);
  await vi.advanceTimersByTimeAsync(30000);
  await pending;
  expect(h.commands).toHaveLength(3);
  expect(h.signals.every((signal) => signal.aborted)).toBe(true);
  await vi.advanceTimersByTimeAsync(6000);
  expect((h.state.get.Body as Readable).destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("destroys a Get stream that settles after the monotonic deadline before the timeout callback runs", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  const h = harness();
  h.state.beforeSend = async (command) => {
    if (command instanceof GetObjectCommand) {
      // Let interruptible register its race while still within the deadline.
      // Only the transport completion clock advances; no timer is dispatched.
      await Promise.resolve();
      elapsed = 30001;
    }
  };
  await expect(h.read()).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(3);
  expect((h.state.get.Body as Readable).destroyed).toBe(true);
  expect(h.signals.every((signal) => signal.aborted)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("external cancellation aborts outstanding SDK work, clears timers and destroys a late stream", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  const h = harness(),
    controller = new AbortController();
  let release: (() => void) | undefined;
  h.state.beforeSend = async (command) => {
    if (command instanceof GetObjectCommand)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  };
  const pending = expect(h.read(h.input, controller.signal)).rejects.toThrow(unavailable);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.commands).toHaveLength(3);
  controller.abort();
  await pending;
  expect(vi.getTimerCount()).toBe(0);
  if (!release) throw Error("Controlled Get did not begin");
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect((h.state.get.Body as Readable).destroyed).toBe(true);
});
it("bounds provider errors and never exposes the bucket, key or transport cause", async () => {
  const h = harness();
  h.state.beforeSend = async () => {
    throw new Error("Access denied for " + h.config.bucket + "/" + h.input.object.key);
  };
  const error: unknown = await h.read().catch((reason: unknown) => reason);
  expect(error).toMatchObject(unavailable);
  expect(error).not.toHaveProperty("cause");
  expect(String(error)).not.toContain(h.config.bucket);
});
