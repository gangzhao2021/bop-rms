import { createHash } from "node:crypto";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMediaScope, createUploadSession, parseMediaChecksum } from "../contracts/media.js";
import {
  createS3ImageUploadProvider,
  type S3ImageUploadInput,
  type S3ImageUploadSdk,
} from "../infrastructure/provider/s3-image-upload-provider.js";

const at = "2026-10-03T12:00:00.000Z",
  time = (ms: number) => new Date(Date.parse(at) + ms).toISOString(),
  id = (n: number) => "019a2421-0020-7000-8000-" + n.toString(16).padStart(12, "0"),
  unavailable = expect.objectContaining({
    code: "MEDIA_UPLOAD_UNAVAILABLE",
    message: "Media upload is unavailable",
  });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(at);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
function fixture(storeReference: string | null = id(3)) {
  const scope = createMediaScope({
      kind: storeReference === null ? "Brand" : "Store",
      brandReference: id(2),
      storeReference,
    } as Parameters<typeof createMediaScope>[0]),
    bytes = Buffer.from("synthetic fixed upload object"),
    checksum = parseMediaChecksum("sha256:" + createHash("sha256").update(bytes).digest("hex")),
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
      state: "Pending",
      version: 1,
      createdAt: at,
      expiresAt: time(900000),
    } as Parameters<typeof createUploadSession>[0]),
    input = { session, key: "quarantine/" + "a".repeat(64), checksum },
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
      $metadata: { httpStatusCode: 200 },
      VersionId: "3/L4kqtJlcpXroDTDmJ+rmSpXd3dIbrHY.M",
      ETag: '"opaque-etag-2"',
      ContentLength: bytes.length,
      ContentType: "image/png",
      ChecksumSHA256: createHash("sha256").update(bytes).digest("base64"),
      ChecksumType: "FULL_OBJECT",
      ServerSideEncryption: "aws:kms",
      SSEKMSKeyId: config.kmsKeyArn,
      Metadata: metadata,
    };
  return { config, input, headers, bytes, metadata };
}
function harness(storeReference: string | null = id(3)) {
  const f = fixture(storeReference),
    commands: HeadObjectCommand[] = [],
    signals: AbortSignal[] = [],
    signingClients: S3Client[] = [],
    signingInputs: Parameters<typeof createPresignedPost>[1][] = [];
  const state: {
    now: string;
    responses: Record<string, unknown>[];
    onSend?: () => Promise<void>;
    onSign?: () => Promise<void>;
    changeSignature?: (result: Awaited<ReturnType<typeof createPresignedPost>>) => void;
  } = { now: at, responses: [structuredClone(f.headers), structuredClone(f.headers)] };
  const sdk: S3ImageUploadSdk = {
    async send(command, options) {
      commands.push(command);
      signals.push(options.abortSignal);
      await state.onSend?.();
      return state.responses[commands.length - 1];
    },
  };
  // Real AWS policy/HMAC code runs entirely offline with explicitly synthetic
  // credentials. No SDK request uses these credentials or contacts an account.
  const offlineClient = new S3Client({
    region: "ca-central-1",
    endpoint: "https://s3.ca-central-1.amazonaws.com",
    forcePathStyle: false,
    useArnRegion: false,
    maxAttempts: 1,
    credentials: {
      accessKeyId: "SYNTHETICKEYID00000000",
      secretAccessKey: "synthetic-local-signing-secret-not-an-aws-credential",
      sessionToken: "synthetic-session-token",
    },
  });
  const sign: typeof createPresignedPost = async (client, options) => {
    signingClients.push(client);
    signingInputs.push(structuredClone(options));
    await state.onSign?.();
    const result = await createPresignedPost(offlineClient, options);
    state.changeSignature?.(result);
    return result;
  };
  const options = { config: f.config, clock: { now: () => state.now }, sdk, sign },
    provider = createS3ImageUploadProvider(options);
  const signUpload = (input: unknown = f.input) => provider.signUpload(input as S3ImageUploadInput),
    verifyUpload = (input: unknown = f.input) => provider.verifyUpload(input as S3ImageUploadInput);
  return {
    ...f,
    provider,
    options,
    state,
    commands,
    signals,
    signingClients,
    signingInputs,
    signUpload,
    verifyUpload,
  };
}
function policy(result: { fields: Readonly<Record<string, string>> }): {
  expiration: string;
  conditions: unknown[];
} {
  const encoded = result.fields.Policy;
  if (!encoded) throw Error("Missing controlled policy");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    expiration: string;
    conditions: unknown[];
  };
}
it.each([id(3), null])(
  "generates a real offline exact-condition POST for %s scope without extending the original session",
  async (storeReference) => {
    const h = harness(storeReference),
      result = await h.signUpload(),
      parsed = policy(result);
    expect(result.url).toBe("https://synthetic-media-quarantine.s3.ca-central-1.amazonaws.com/");
    expect(result.expiresAt).toBe(h.input.session.expiresAt);
    expect(parsed.expiration).toBe("2026-10-03T12:15:00Z");
    expect(Object.isFrozen(result.fields)).toBe(true);
    expect(result.fields).toMatchObject({
      bucket: h.config.bucket,
      key: h.input.key,
      "Content-Type": "image/png",
      success_action_status: "204",
      "x-amz-checksum-algorithm": "SHA256",
      "x-amz-checksum-sha256": h.headers.ChecksumSHA256,
      "x-amz-server-side-encryption": "aws:kms",
      "x-amz-server-side-encryption-aws-kms-key-id": h.config.kmsKeyArn,
    });
    for (const [key, value] of Object.entries(h.metadata))
      expect(result.fields["x-amz-meta-" + key]).toBe(value);
    expect(parsed.conditions).toContainEqual([
      "content-length-range",
      h.bytes.length,
      h.bytes.length,
    ]);
    for (const [key, value] of Object.entries(result.fields))
      if (key !== "Policy" && key !== "X-Amz-Signature")
        expect(parsed.conditions).toContainEqual({ [key]: value });
    expect(parsed.conditions.some((item) => Array.isArray(item) && item[0] === "starts-with")).toBe(
      false,
    );
    expect(result.fields).not.toHaveProperty("tagging");
    expect(result.fields).not.toHaveProperty("acl");
    expect(result.fields).not.toHaveProperty("success_action_redirect");
    expect(h.commands).toHaveLength(0);
    expect(h.signingInputs[0]?.Expires).toBe(900);
  },
);
it("bases SDK expiration on the real signing clock while retaining the independent business admission clock", async () => {
  const h = harness();
  h.state.now = time(60000);
  const result = await h.signUpload();
  expect(h.signingInputs[0]?.Expires).toBe(900);
  expect(result.expiresAt).toBe(h.input.session.expiresAt);
});
it("discovers current once and then verifies only its exact non-null version and opaque ETag", async () => {
  const h = harness(),
    result = await h.verifyUpload(),
    common = {
      Bucket: h.config.bucket,
      Key: h.input.key,
      ExpectedBucketOwner: h.config.accountId,
      ChecksumMode: "ENABLED",
    };
  expect(h.commands.map((command) => command.input)).toEqual([
    common,
    { ...common, VersionId: h.headers.VersionId, IfMatch: h.headers.ETag },
  ]);
  expect(new Set(h.signals).size).toBe(1);
  expect(result).toEqual({
    versionId: h.headers.VersionId,
    etag: "opaque-etag-2",
    byteSize: h.bytes.length,
    checksum: h.input.checksum,
    contentType: "image/png",
    observedAt: at,
  });
  expect(result).not.toHaveProperty("readinessState");
  expect(h.signingInputs).toHaveLength(0);
});
it.each([
  "version",
  "null-version",
  "etag",
  "length",
  "checksum",
  "checksum-type",
  "kms",
  "metadata",
  "redirect",
  "encoding",
  "delete-marker",
  "status",
])("rejects a mismatched %s explicit-version response", async (fault) => {
  const h = harness(),
    changes: Record<string, object> = {
      version: { VersionId: "other-version" },
      "null-version": { VersionId: "null" },
      etag: { ETag: '"other-etag"' },
      length: { ContentLength: h.bytes.length + 1 },
      checksum: { ChecksumSHA256: Buffer.alloc(32).toString("base64") },
      "checksum-type": { ChecksumType: "COMPOSITE" },
      kms: { SSEKMSKeyId: h.config.kmsKeyArn + "x" },
      metadata: { Metadata: { ...h.metadata, "bop-store-reference": id(99) } },
      redirect: { WebsiteRedirectLocation: "https://foreign.invalid/" },
      encoding: { ContentEncoding: "gzip" },
      "delete-marker": { DeleteMarker: true },
      status: { $metadata: { httpStatusCode: 301 } },
    };
  h.state.responses[1] = { ...h.headers, ...changes[fault] };
  await expect(h.verifyUpload()).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(2);
});
it("does not accept a current unversioned object or try a fallback HEAD", async () => {
  const h = harness();
  h.state.responses[0] = { ...h.headers, VersionId: "null" };
  await expect(h.verifyUpload()).rejects.toThrow(unavailable);
  expect(h.commands).toHaveLength(1);
});
it.each(["foreign-scope", "finalized", "oversize", "gif", "free-key", "checksum", "extra"])(
  "rejects %s original inputs before signing or HEAD",
  async (fault) => {
    const h = harness(),
      input = {
        ...h.input,
        ...(fault === "extra" ? { uploadUrl: "https://untrusted.invalid/" } : {}),
        ...(fault === "free-key" ? { key: "quarantine/original-name.png" } : {}),
        ...(fault === "checksum" ? { checksum: "sha256:bad" } : {}),
        session: {
          ...h.input.session,
          ...(fault === "foreign-scope"
            ? { scope: { ...h.input.session.scope, brandReference: id(99) } }
            : {}),
          ...(fault === "finalized" ? { state: "Finalized", version: 2 } : {}),
          ...(fault === "oversize" ? { declaredByteSize: 10 * 1024 * 1024 + 1 } : {}),
          ...(fault === "gif" ? { declaredContentType: "image/gif" } : {}),
        },
      };
    await expect(h.signUpload(input)).rejects.toThrow(unavailable);
    await expect(h.verifyUpload(input)).rejects.toThrow(unavailable);
    expect(h.commands).toHaveLength(0);
    expect(h.signingInputs).toHaveLength(0);
  },
);
it.each(["redirect-url", "tagging", "relaxed-policy", "later-expiry", "wrong-field"])(
  "does not return a signer result with %s",
  async (fault) => {
    const h = harness();
    h.state.changeSignature = (result) => {
      if (fault === "redirect-url") result.url = "https://foreign.invalid/";
      if (fault === "tagging") result.fields.tagging = "<Tagging/>";
      if (fault === "wrong-field") result.fields["x-amz-meta-bop-tenant-reference"] = id(99);
      if (fault === "later-expiry" || fault === "relaxed-policy") {
        const parsed = policy(result);
        if (fault === "later-expiry") parsed.expiration = time(901000);
        else
          parsed.conditions = parsed.conditions.map((condition) =>
            Array.isArray(condition) && condition[0] === "content-length-range"
              ? ["content-length-range", 1, 10 * 1024 * 1024]
              : condition,
          );
        result.fields.Policy = Buffer.from(JSON.stringify(parsed)).toString("base64");
      }
    };
    await expect(h.signUpload()).rejects.toThrow(unavailable);
    expect(h.commands).toHaveLength(0);
  },
);
it("captures configured ports and original metadata before awaiting provider work", async () => {
  const h = harness(),
    input = { ...h.input, session: { ...h.input.session } };
  h.options.clock.now = () => {
    throw Error("Replaced clock");
  };
  h.options.sdk.send = async () => {
    throw Error("Replaced SDK");
  };
  h.options.sign = async () => {
    throw Error("Replaced signer");
  };
  h.options.config.bucket = "different-bucket";
  h.state.onSend = async () => {
    input.key = "mutated";
  };
  const result = await h.verifyUpload(input);
  expect(result.versionId).toBe(h.headers.VersionId);
  expect(h.commands[1]?.input.Key).toBe(h.input.key);
  expect((await h.signUpload()).url).toBe(
    "https://synthetic-media-quarantine.s3.ca-central-1.amazonaws.com/",
  );
});
it("does not invoke caller accessors", async () => {
  const h = harness(),
    input = { ...h.input },
    getter = vi.fn(() => h.input.session);
  Object.defineProperty(input, "session", { enumerable: true, get: getter });
  await expect(h.signUpload(input)).rejects.toThrow(unavailable);
  expect(getter).not.toHaveBeenCalled();
  expect(h.signingInputs).toHaveLength(0);
});
it.each(["expired", "backwards", "late-expiry"])(
  "retains session and monotonic clock admission for %s",
  async (fault) => {
    const h = harness();
    if (fault === "expired") h.state.now = h.input.session.expiresAt;
    else
      h.state.onSend = async () => {
        h.state.now = fault === "backwards" ? time(-1) : time(30000);
      };
    await expect(h.verifyUpload()).rejects.toThrow(unavailable);
    expect(h.commands.length).toBe(fault === "expired" ? 0 : 1);
  },
);
it.each(["sign", "verify"])(
  "bounds a stalled %s call by the same original 30 seconds",
  async (method) => {
    const h = harness(),
      stall = async () => {
        await new Promise(() => {
          /* Controlled provider remains unsettled. */
        });
      };
    if (method === "sign") h.state.onSign = stall;
    else h.state.onSend = stall;
    const pending = expect(method === "sign" ? h.signUpload() : h.verifyUpload()).rejects.toThrow(
      unavailable,
    );
    await vi.advanceTimersByTimeAsync(30000);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    if (method === "verify") expect(h.signals[0]?.aborted).toBe(true);
  },
);
it("stops a stalled verification at the original session's earlier expiry", async () => {
  const h = harness();
  h.state.onSend = async () => {
    await new Promise(() => {
      /* Never settle before the session expires. */
    });
  };
  const pending = expect(
    h.verifyUpload({ ...h.input, session: { ...h.input.session, expiresAt: time(2000) } }),
  ).rejects.toThrow(unavailable);
  await vi.advanceTimersByTimeAsync(2000);
  await pending;
  expect(h.signals[0]?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps the default SDK endpoint fixed despite environment overrides and bounds provider error details", async () => {
  vi.stubEnv("AWS_ENDPOINT_URL", "https://foreign.invalid/");
  vi.stubEnv("AWS_ENDPOINT_URL_S3", "http://127.0.0.1:9999/");
  const h = harness();
  await h.signUpload();
  const client = h.signingClients[0];
  if (!client) throw Error("No controlled signing client");
  const useArnRegion = client.config.useArnRegion,
    endpoint = client.config.endpoint;
  expect(await client.config.region()).toBe("ca-central-1");
  expect(typeof useArnRegion === "function" ? await useArnRegion() : useArnRegion).toBe(false);
  expect(client.config.followRegionRedirects).toBe(false);
  if (typeof endpoint !== "function") throw Error("Missing fixed endpoint provider");
  expect(await endpoint()).toMatchObject({
    protocol: "https:",
    hostname: "s3.ca-central-1.amazonaws.com",
  });
  h.state.onSend = async () => {
    throw Error("Denied at private bucket " + h.config.bucket);
  };
  const error: unknown = await h.verifyUpload().catch((reason: unknown) => reason);
  expect(error).toMatchObject(unavailable);
  expect(error).not.toHaveProperty("cause");
  expect(String(error)).not.toContain(h.config.bucket);
});
