import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import sharp from "sharp";
import { afterEach, expect, it, vi } from "vitest";
import {
  CopyObjectCommand,
  GetObjectCommand,
  GetObjectTaggingCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
} from "../contracts/media.js";
import {
  parseMediaImagePromotionPlan,
  mediaImagePromotionPlanDigest,
} from "../infrastructure/processing/media-image-promotion.js";
import {
  createS3ImagePromotionWriter,
  type S3ImagePromotionSdk,
} from "../infrastructure/provider/s3-image-promotion-writer.js";

const defaults = vi.hoisted(() => ({
  configurations: [] as unknown[],
  send: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...(await original<typeof import("@aws-sdk/client-s3")>()),
  S3Client: class {
    constructor(config: unknown) {
      defaults.configurations.push(config);
    }
    send = defaults.send;
    destroy = defaults.destroy;
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
  defaults.configurations.length = 0;
});

it("closes its owned default SDK once and rejects later work without Provider calls", async () => {
  const f = await fixture();
  const writer = createS3ImagePromotionWriter({
    quarantineConfig: f.config,
    clock: { now: () => now },
  });
  writer.close();
  writer.close();
  expect(defaults.destroy).toHaveBeenCalledTimes(1);
  await expect(writer.process({ source: f.source, plan: f.plan })).rejects.toThrow(unavailable);
  expect(defaults.send).not.toHaveBeenCalled();
});

it("aborts pending controlled I/O on close without taking ownership of the supplied SDK", async () => {
  const f = await fixture();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.state.before = (_command, signal) =>
    new Promise<void>((_resolve, reject) => {
      entered();
      signal.addEventListener("abort", () => reject(new Error("controlled cancelled request")), {
        once: true,
      });
    });
  const processing = f.writer.process({ source: f.source, plan: f.plan });
  await started;
  f.writer.close();
  await expect(processing).rejects.toThrow(unavailable);
  expect(f.writes).toHaveLength(0);
  expect(defaults.destroy).not.toHaveBeenCalled();
});
const id = (n: number) => "019a2421-0021-7000-8000-" + n.toString(16).padStart(12, "0"),
  hash = (bytes: Uint8Array) => "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  encoded = (checksum: string) => Buffer.from(checksum.slice(7), "hex").toString("base64"),
  now = "2026-10-03T12:01:00.000Z",
  unavailable = expect.objectContaining({
    code: "MEDIA_IMAGE_PROMOTION_UNAVAILABLE",
    message: "Media image promotion is unavailable",
  });
type Command = Parameters<S3ImagePromotionSdk["send"]>[0];
interface StoredObject {
  bytes: Buffer;
  versionId: string;
  etag: string;
  headers: Record<string, unknown>;
}
// Real decoder/encoder and S3 command composition with controlled in-memory SDK
// responses. These fixtures establish neither live AWS/IAM nor database promotion.
async function fixture() {
  const bytes = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 4,
        background: { r: 40, g: 100, b: 160, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer(),
    scope = createMediaScope({
      kind: "Store",
      brandReference: id(2),
      storeReference: id(3),
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
      declaredContentType: "image/png",
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
    assetVersion = createMediaAssetVersion({
      assetVersionId: id(9),
      assetId: asset.assetId,
      version: 1,
      objectEvidenceReference: id(10),
      providerObjectVersion: id(11),
      byteSize: bytes.length,
      checksum: hash(bytes),
      contentType: "image/png",
      checkState: "Quarantined",
      readinessState: "Pending",
      createdAt: "2026-10-03T12:00:01.000Z",
    } as Parameters<typeof createMediaAssetVersion>[0]),
    object = {
      bucket: config.bucket,
      key: "quarantine/" + "a".repeat(64),
      versionId: "source/version+with=symbols",
      etag: "source-etag",
      objectEvidenceReference: id(10),
      providerObjectVersion: id(11),
    },
    scanEvent = {
      version: "0",
      id: "synthetic-scan-event",
      "detail-type": "GuardDuty Malware Protection Object Scan Result",
      source: "aws.guardduty",
      account: config.accountId,
      time: "2026-10-03T12:00:02Z",
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
    source = {
      tenantReference: config.tenantReference,
      session,
      asset,
      assetVersion,
      object,
      scanEvent,
    },
    planned = (n: number) => ({
      key: "clean/" + n.toString(16).padStart(64, "0"),
      objectEvidenceReference: id(100 + n),
      providerObjectVersion: id(200 + n),
    }),
    plan = parseMediaImagePromotionPlan({
      profile: "PUBLIC_IMAGE_V1",
      operationReference: id(20),
      tenantReference: id(1),
      scope,
      assetReference: id(8),
      sourceAssetVersionReference: id(9),
      targetAssetVersionReference: id(21),
      expectedAssetVersion: 1,
      sourceBindingDigest: "sha256:" + "d".repeat(64),
      destination: {
        accountId: config.accountId,
        bucket: "synthetic-media-clean",
        cleanPrefix: "clean/",
        kmsKeyArn: config.kmsKeyArn,
      },
      original: planned(1),
      renditions: [320, 640, 1280].flatMap((width, index) => [
        { ...planned(index * 2 + 2), contentType: "image/jpeg", width },
        { ...planned(index * 2 + 3), contentType: "image/webp", width },
      ]),
    });
  const sourceHeaders = {
    $metadata: { httpStatusCode: 200 },
    VersionId: object.versionId,
    ETag: '"' + object.etag + '"',
    ContentLength: bytes.length,
    ContentType: "image/png",
    ChecksumType: "FULL_OBJECT",
    ChecksumSHA256: encoded(assetVersion.checksum),
    ServerSideEncryption: "aws:kms",
    SSEKMSKeyId: config.kmsKeyArn,
    Metadata: {
      "bop-tenant-reference": id(1),
      "bop-brand-reference": id(2),
      "bop-store-reference": id(3),
      "bop-upload-session-reference": id(4),
      "bop-actor-reference": id(6),
      "bop-purpose": session.purpose,
      "bop-owner-type": session.ownerType,
      "bop-owner-reference": id(7),
      "bop-classification": session.classification,
    },
  };
  const calls: Command[] = [],
    stored = new Map<string, StoredObject>(),
    writes: Command[] = [];
  const state: {
    clock: string;
    tag: string;
    sourceHeads: number;
    before?: (command: Command, signal: AbortSignal) => Promise<void> | void;
    after?: (command: Command, response: unknown) => unknown;
    writeFault?: "unknown-once" | "precondition-once" | "before-put" | "malformed-copy";
  } = { clock: now, tag: "NO_THREATS_FOUND", sourceHeads: 0 };
  const sdk: S3ImagePromotionSdk = {
    async send(command, options) {
      calls.push(command);
      await state.before?.(command, options.abortSignal);
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      const input = command.input;
      let response: unknown;
      if (input.Bucket === config.bucket) {
        expect(input.Key).toBe(object.key);
        expect(input.ExpectedBucketOwner).toBe(config.accountId);
        if (command instanceof HeadObjectCommand) {
          state.sourceHeads++;
          expect(command.input.VersionId).toBe(object.versionId);
          response = { ...sourceHeaders };
        } else if (command instanceof GetObjectTaggingCommand)
          response = {
            $metadata: { httpStatusCode: 200 },
            VersionId: object.versionId,
            TagSet: [{ Key: "GuardDutyMalwareScanStatus", Value: state.tag }],
          };
        else if (command instanceof GetObjectCommand) {
          expect(command.input.VersionId).toBe(object.versionId);
          expect(command.input.IfMatch).toBe('"' + object.etag + '"');
          response = { ...sourceHeaders, Body: Readable.from([bytes]) };
        } else throw Error("Unexpected source mutation");
      } else if (command instanceof HeadObjectCommand) {
        const row = stored.get(String(input.Key));
        if (!row)
          throw Object.assign(new Error("Synthetic absent"), {
            name: "NotFound",
            $metadata: { httpStatusCode: 404 },
          });
        if (command.input.VersionId !== undefined) {
          expect(command.input.VersionId).toBe(row.versionId);
          expect(command.input.IfMatch).toBe('"' + row.etag + '"');
        }
        response = { ...row.headers };
      } else if (command instanceof CopyObjectCommand || command instanceof PutObjectCommand) {
        writes.push(command);
        if (command instanceof PutObjectCommand && state.writeFault === "before-put") {
          delete state.writeFault;
          throw Error("Synthetic transport failure before write");
        }
        const writeInput = command.input;
        const content =
            command instanceof CopyObjectCommand
              ? bytes
              : Buffer.from(command.input.Body as Uint8Array),
          versionId = "destination-version-" + writes.length,
          targetEtag = "destination-etag-" + writes.length,
          headers = {
            $metadata: { httpStatusCode: 200 },
            VersionId: versionId,
            ETag: '"' + targetEtag + '"',
            ContentType: writeInput.ContentType,
            ContentLength: content.length,
            ChecksumType: "FULL_OBJECT",
            ChecksumSHA256: encoded(hash(content)),
            ServerSideEncryption: writeInput.ServerSideEncryption,
            SSEKMSKeyId: writeInput.SSEKMSKeyId,
            Metadata: { ...writeInput.Metadata },
            ...(writeInput.ContentDisposition === undefined
              ? {}
              : { ContentDisposition: writeInput.ContentDisposition }),
          };
        if (command instanceof PutObjectCommand) {
          expect(command.input.IfNoneMatch).toBe("*");
          expect(command.input.ChecksumSHA256).toBe(headers.ChecksumSHA256);
          expect(command.input.ContentLength).toBe(content.length);
        }
        stored.set(String(input.Key), { bytes: content, versionId, etag: targetEtag, headers });
        if (state.writeFault === "unknown-once" || state.writeFault === "precondition-once") {
          const fault = state.writeFault;
          delete state.writeFault;
          throw Object.assign(
            new Error("Synthetic unknown completion"),
            fault === "precondition-once"
              ? { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } }
              : {},
          );
        }
        response =
          command instanceof CopyObjectCommand
            ? {
                $metadata: { httpStatusCode: 200 },
                VersionId: versionId,
                CopySourceVersionId: object.versionId,
                CopyObjectResult: { ETag: headers.ETag, ChecksumSHA256: headers.ChecksumSHA256 },
                ServerSideEncryption: headers.ServerSideEncryption,
                SSEKMSKeyId: headers.SSEKMSKeyId,
              }
            : headers;
        if (command instanceof CopyObjectCommand && state.writeFault === "malformed-copy")
          response = { $metadata: { httpStatusCode: 200 }, Error: { Code: "InternalError" } };
      } else throw Error("Unexpected synthetic command");
      return state.after ? state.after(command, response) : response;
    },
  };
  const options = { quarantineConfig: config, clock: { now: () => state.clock }, sdk },
    writer = createS3ImagePromotionWriter(options);
  return { bytes, config, source, plan, state, calls, stored, writes, sdk, options, writer };
}

it("decodes actual PNG bytes, copies the private original and verifies all six encoded derivatives", async () => {
  const f = await fixture(),
    result = await f.writer.process({ source: f.source, plan: f.plan });
  expect(result.planDigest).toBe(mediaImagePromotionPlanDigest(f.plan));
  expect(result.renditions).toHaveLength(6);
  expect(result.original.checksum).toBe(hash(f.bytes));
  expect(result.original.contentType).toBe("image/png");
  expect(result.renditions.some((r) => r.key === result.original.key)).toBe(false);
  expect(
    result.renditions.find((r) => r.contentType === "image/jpeg" && r.width === 1280)?.key,
  ).not.toBe(result.original.key);
  const copy = f.writes.find((command) => command instanceof CopyObjectCommand);
  if (!(copy instanceof CopyObjectCommand)) throw Error("Expected actual copy command");
  expect(copy.input).toMatchObject({
    CopySource:
      f.config.bucket +
      "/" +
      f.source.object.key +
      "?versionId=" +
      encodeURIComponent(f.source.object.versionId),
    CopySourceIfMatch: '"source-etag"',
    ExpectedSourceBucketOwner: f.config.accountId,
    ExpectedBucketOwner: f.config.accountId,
    MetadataDirective: "REPLACE",
    TaggingDirective: "REPLACE",
    Tagging: "",
    ContentDisposition: "attachment",
    ChecksumAlgorithm: "SHA256",
  });
  expect(f.writes).toHaveLength(7);
  expect(f.state.sourceHeads).toBe(3);
  for (const rendition of result.renditions) {
    const row = f.stored.get(rendition.key);
    if (!row) throw Error("Missing actual output");
    const decoded = await sharp(row.bytes).metadata();
    expect(decoded.format).toBe(rendition.contentType.slice(6));
    expect(decoded.width).toBe(rendition.width);
    expect(decoded.height).toBe(rendition.height);
    expect(decoded.exif).toBeUndefined();
    expect(decoded.icc).toBeUndefined();
    expect(rendition.checksum).toBe(hash(row.bytes));
    expect(row.headers.Metadata).toMatchObject({
      "bop-plan-digest": result.planDigest,
      "bop-source-asset-version-reference": f.source.assetVersion.assetVersionId,
    });
  }
  expect(result.sourceEvidence.providerObjectVersion).toBe(
    f.source.assetVersion.providerObjectVersion,
  );
  expect(result.scanEvidence.result).toBe("NO_THREATS_FOUND");
  expect(Object.isFrozen(result)).toBe(true);
});

it("reuses exact planned objects on retry with zero additional writes and fresh source/pinned checks", async () => {
  const f = await fixture(),
    first = await f.writer.process({ source: f.source, plan: f.plan });
  f.calls.length = 0;
  const second = await f.writer.process({ source: f.source, plan: f.plan });
  expect(second).toEqual(first);
  expect(f.writes).toHaveLength(7);
  expect(
    f.calls.filter(
      (c) => c instanceof HeadObjectCommand && c.input.Bucket === f.plan.destination.bucket,
    ),
  ).toHaveLength(14);
  expect(f.calls.some((c) => c instanceof GetObjectTaggingCommand)).toBe(true);
});

it.each(["unknown-once", "precondition-once"] as const)(
  "recovers a %s conditional derivative completion by exact HEAD without overwriting",
  async (fault) => {
    const f = await fixture();
    f.state.before = (command) => {
      if (command instanceof PutObjectCommand && f.writes.length === 1) f.state.writeFault = fault;
    };
    const result = await f.writer.process({ source: f.source, plan: f.plan });
    expect(result.renditions).toHaveLength(6);
    expect(f.writes).toHaveLength(7);
  },
);

it("recovers an unknown Copy result and retries only missing objects after a partial failure", async () => {
  const f = await fixture();
  f.state.writeFault = "unknown-once";
  f.state.before = (command) => {
    if (command instanceof PutObjectCommand && f.writes.length === 1)
      f.state.writeFault = "before-put";
  };
  await expect(f.writer.process({ source: f.source, plan: f.plan })).rejects.toThrow(unavailable);
  expect(f.stored.size).toBe(1);
  delete f.state.before;
  const result = await f.writer.process({ source: f.source, plan: f.plan });
  expect(result.renditions).toHaveLength(6);
  expect(f.writes.filter((c) => c instanceof CopyObjectCommand)).toHaveLength(1);
});

it.each(["checksum", "metadata", "kms", "type", "size", "null-version", "encoding", "pin-version"])(
  "refuses mismatched existing %s without any additional write",
  async (fault) => {
    const f = await fixture();
    await f.writer.process({ source: f.source, plan: f.plan });
    f.writes.length = 0;
    f.state.after = (command, response) => {
      if (
        !(command instanceof HeadObjectCommand) ||
        command.input.Bucket !== f.plan.destination.bucket
      )
        return response;
      const value = response as Record<string, unknown>;
      if (fault === "pin-version" && command.input.VersionId === undefined) return value;
      return {
        ...value,
        ...(fault === "checksum"
          ? { ChecksumSHA256: encoded("sha256:" + "f".repeat(64)) }
          : fault === "metadata"
            ? {
                Metadata: {
                  ...(value.Metadata as object),
                  "bop-plan-digest": "sha256:" + "f".repeat(64),
                },
              }
            : fault === "kms"
              ? { SSEKMSKeyId: f.config.kmsKeyArn.replace("aaaaaaaa", "bbbbbbbb") }
              : fault === "type"
                ? { ContentType: "text/html" }
                : fault === "size"
                  ? { ContentLength: 1 }
                  : fault === "null-version"
                    ? { VersionId: "null" }
                    : fault === "encoding"
                      ? { ContentEncoding: "gzip" }
                      : { VersionId: "wrong-pinned-version" }),
      };
    };
    await expect(f.writer.process({ source: f.source, plan: f.plan })).rejects.toThrow(unavailable);
    expect(f.writes).toHaveLength(0);
  },
);

it.each([403, 404, 500])(
  "does not treat an ambiguous %s error as an absent destination",
  async (code) => {
    const f = await fixture();
    f.state.before = (command) => {
      if (
        command instanceof HeadObjectCommand &&
        command.input.Bucket === f.plan.destination.bucket
      )
        throw Object.assign(new Error("Synthetic denied/unknown"), {
          name: "AccessDenied",
          $metadata: { httpStatusCode: code },
        });
    };
    await expect(f.writer.process({ source: f.source, plan: f.plan })).rejects.toThrow(unavailable);
    expect(f.writes).toHaveLength(0);
  },
);

it("rejects an embedded Copy 200 error even when a destination row happens to exist", async () => {
  const f = await fixture();
  f.state.writeFault = "malformed-copy";
  await expect(f.writer.process({ source: f.source, plan: f.plan })).rejects.toThrow(unavailable);
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toBeInstanceOf(CopyObjectCommand);
});

it.each(["before-copy", "before-result"])("rechecks actual source scan state %s", async (when) => {
  const f = await fixture();
  f.state.before = (command) => {
    if (
      command instanceof GetObjectTaggingCommand &&
      ((when === "before-copy" && f.state.sourceHeads === 2) ||
        (when === "before-result" && f.writes.length === 7))
    )
      f.state.tag = "THREATS_FOUND";
  };
  await expect(f.writer.process({ source: f.source, plan: f.plan })).rejects.toThrow(unavailable);
  expect(f.writes.length).toBe(when === "before-copy" ? 0 : 7);
});

it("allows a later expected Asset root without rewriting the original v1 quarantine snapshot", async () => {
  const f = await fixture(),
    plan = parseMediaImagePromotionPlan({ ...f.plan, expectedAssetVersion: 3 });
  expect((await f.writer.process({ source: f.source, plan })).renditions).toHaveLength(6);
  expect(f.source.asset.version).toBe(1);
  expect(f.source.asset.currentVersionReference).toBeNull();
});

it.each(["tenant", "source-version", "account", "overlap"])(
  "rejects a %s plan/source mismatch before SDK work",
  async (fault) => {
    const f = await fixture(),
      destination =
        fault === "overlap"
          ? {
              ...f.plan.destination,
              bucket: f.config.bucket,
              cleanPrefix: f.config.quarantinePrefix,
            }
          : fault === "account"
            ? {
                ...f.plan.destination,
                accountId: "999900001111",
                kmsKeyArn: f.plan.destination.kmsKeyArn.replace("111122223333", "999900001111"),
              }
            : f.plan.destination;
    const plan = {
      ...f.plan,
      tenantReference: fault === "tenant" ? id(99) : f.plan.tenantReference,
      sourceAssetVersionReference:
        fault === "source-version" ? id(98) : f.plan.sourceAssetVersionReference,
      destination,
      original:
        fault === "overlap"
          ? { ...f.plan.original, key: f.plan.original.key.replace("clean/", "quarantine/") }
          : f.plan.original,
      renditions:
        fault === "overlap"
          ? f.plan.renditions.map((r) => ({ ...r, key: r.key.replace("clean/", "quarantine/") }))
          : f.plan.renditions,
    };
    await expect(f.writer.process({ source: f.source, plan })).rejects.toThrow(unavailable);
    expect(f.calls).toHaveLength(0);
  },
);

it("captures original caller data and configured ports before the first await", async () => {
  const f = await fixture(),
    input = structuredClone({ source: f.source, plan: f.plan }),
    capturedSend = f.sdk.send;
  f.state.before = () => {
    Object.assign(input.plan, { operationReference: id(99) });
    Object.assign(input.source.object, { versionId: "mutated" });
    f.sdk.send = async () => {
      throw Error("Changed port");
    };
  };
  const result = await f.writer.process(input);
  expect(result.operationReference).toBe(f.plan.operationReference);
  expect(result.sourceEvidence.versionId).toBe(f.source.object.versionId);
  expect(capturedSend).not.toBe(f.sdk.send);
});

it("honors cancellation of a pending source request without starting object writes", async () => {
  const f = await fixture(),
    controller = new AbortController();
  let entered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.state.before = (_command, signal) =>
    new Promise<void>((_resolve, reject) => {
      entered();
      signal.addEventListener("abort", () => reject(Error("Synthetic cancelled request")), {
        once: true,
      });
    });
  const operation = f.writer.process({ source: f.source, plan: f.plan }, controller.signal);
  const rejected = expect(operation).rejects.toThrow(unavailable);
  await started;
  controller.abort();
  await rejected;
  expect(f.writes).toHaveLength(0);
});

it.each(["monotonic", "clock"])(
  "covers all work with the original 180-second %s deadline",
  async (kind) => {
    const f = await fixture();
    let elapsed = 0;
    if (kind === "monotonic") vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    f.state.before = (command) => {
      if (
        command instanceof HeadObjectCommand &&
        command.input.Bucket === f.plan.destination.bucket
      ) {
        if (kind === "monotonic") elapsed = 180000;
        else f.state.clock = "2026-10-03T12:04:00.000Z";
      }
    };
    await expect(f.writer.process({ source: f.source, plan: f.plan })).rejects.toThrow(unavailable);
    expect(f.writes).toHaveLength(0);
  },
);

it("uses the fixed actual SDK endpoint when no controlled SDK is supplied", async () => {
  const f = await fixture();
  defaults.send.mockImplementation(f.sdk.send);
  const writer = createS3ImagePromotionWriter({
    quarantineConfig: f.config,
    clock: { now: () => f.state.clock },
  });
  expect(defaults.configurations).toEqual([
    expect.objectContaining({
      region: "ca-central-1",
      endpoint: "https://s3.ca-central-1.amazonaws.com",
      forcePathStyle: false,
      followRegionRedirects: false,
      useDualstackEndpoint: false,
      maxAttempts: 1,
    }),
  ]);
  expect((await writer.process({ source: f.source, plan: f.plan })).renditions).toHaveLength(6);
});
