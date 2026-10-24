import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { expect, it, vi } from "vitest";
import {
  mediaUploadStorageIntentDigest,
  mediaUploadStorageResult,
  parseMediaUploadStorageCommand,
} from "../contracts/media-upload-storage.js";
import { parseS3QuarantineImageConfig } from "../infrastructure/provider/s3-quarantine-image-source.js";
import {
  loadMediaImageProcessingSource,
  resolveMediaImageProcessingSource,
} from "../infrastructure/persistence/media-image-processing-source.js";
import type { MediaPersistenceTransaction } from "../infrastructure/persistence/media-upload-store.js";

const id = (n: number) => "019a2421-0021-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const at = "2026-10-03T12:00:00.000Z";
const unavailable = expect.objectContaining({
  code: "MEDIA_IMAGE_PROCESSING_UNAVAILABLE",
  message: "Media image processing is unavailable",
});

it("resolves an authenticated delivery by its exact private object before loading owning history", async () => {
  const f = fixture(),
    calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: MediaPersistenceTransaction = {
    query: async <Row>(sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      return {
        rows: (calls.length === 1
          ? [{ reference: id(9), coherent: true }]
          : [f.row]) as unknown as readonly Row[],
      };
    },
  };
  const result = await resolveMediaImageProcessingSource(tx, f.config, f.event);
  expect(result.source.assetVersion.assetVersionId).toBe(id(9));
  expect(calls).toHaveLength(2);
  expect(calls[0]?.values).toEqual([
    id(1),
    id(2),
    id(3),
    f.binding.object.bucket,
    f.binding.object.key,
    f.binding.object.versionId,
    f.binding.object.etag,
  ]);
  expect(calls[1]?.values).toEqual([id(1), id(2), id(3), id(9)]);
});

it.each([
  { rows: [] },
  { rows: [{ reference: id(9), coherent: false }] },
  {
    rows: [
      { reference: id(9), coherent: true },
      { reference: id(9), coherent: true },
    ],
  },
])("refuses absent, ambiguous or incoherent exact-object resolution", async ({ rows }) => {
  const f = fixture(),
    query = vi.fn(async () => ({ rows }));
  await expect(
    resolveMediaImageProcessingSource({ query } as MediaPersistenceTransaction, f.config, f.event),
  ).rejects.toThrow(unavailable);
  expect(query).toHaveBeenCalledTimes(1);
});

it("rejects foreign bucket, prefix, null version or non-clean event before any private lookup", async () => {
  const f = fixture(),
    query = vi.fn();
  for (const change of [
    { bucketName: "other-quarantine" },
    { objectKey: "other/" + "a".repeat(64) },
    { versionId: "null" },
    { eTag: '"unclosed"' },
  ]) {
    const event = {
      ...f.event,
      detail: {
        ...f.event.detail,
        s3ObjectDetails: { ...f.event.detail.s3ObjectDetails, ...change },
      },
    };
    await expect(resolveMediaImageProcessingSource({ query }, f.config, event)).rejects.toThrow(
      unavailable,
    );
  }
  await expect(
    resolveMediaImageProcessingSource({ query }, f.config, { ...f.event, account: "999988887777" }),
  ).rejects.toThrow(unavailable);
  expect(query).not.toHaveBeenCalled();
});
function fixture() {
  const config = parseS3QuarantineImageConfig({
    tenantReference: id(1),
    scope: { kind: "Store", brandReference: id(2), storeReference: id(3) },
    region: "ca-central-1",
    accountId: "111122223333",
    bucket: "synthetic-quarantine-images",
    quarantinePrefix: "quarantine/",
    kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    protectionPlanArn:
      "arn:aws:guardduty:ca-central-1:111122223333:malware-protection-plan/synthetic123",
  });
  const session = {
    uploadSessionId: id(4),
    grantReference: id(5),
    actorReference: id(6),
    purpose: "PRODUCT_IMAGE",
    scope: config.scope,
    mediaKind: "Image",
    declaredContentType: "image/png",
    declaredByteSize: 1234,
    ownerType: "PRODUCT",
    ownerReference: id(7),
    classification: "Public",
    state: "Pending",
    version: 1,
    createdAt: at,
    expiresAt: "2026-10-03T12:15:00.000Z",
  };
  const audit = (final: boolean) => ({
    auditId: id(final ? 11 : 10),
    brandId: id(2),
    storeId: id(3),
    actor: { type: "User", reference: id(6) },
    actionCode: final ? "MEDIA_ASSET_FINALIZED" : "MEDIA_UPLOAD_CREATED",
    reasonCode: final ? "MEDIA_ASSET_FINALIZED" : "MEDIA_UPLOAD_CREATED",
    targetType: final ? "MediaAsset" : "MediaUploadSession",
    targetId: final ? id(8) : id(4),
    correlationId: id(12),
    occurredAt: final ? "2026-10-03T12:00:01.000Z" : at,
    sourceChannel: "API",
    dataClassification: "Confidential",
    retentionPolicyCode: "MEDIA_OPERATION_AUDIT",
    retentionPolicyVersion: 1,
  });
  const create = parseMediaUploadStorageCommand({
    tenantReference: config.tenantReference,
    scope: config.scope,
    actorReference: id(6),
    action: "CreateUpload",
    input: { idempotencyKey: id(13), session, audit: audit(false) },
  });
  const final = parseMediaUploadStorageCommand({
    tenantReference: config.tenantReference,
    scope: config.scope,
    actorReference: id(6),
    action: "FinalizeAsset",
    input: {
      idempotencyKey: id(14),
      expectedSessionVersion: 1,
      closedSession: { ...session, state: "Finalized", version: 2 },
      asset: {
        assetId: id(8),
        purpose: session.purpose,
        scope: config.scope,
        mediaKind: "Image",
        ownerType: session.ownerType,
        ownerReference: session.ownerReference,
        classification: session.classification,
        currentVersionReference: null,
        version: 1,
      },
      assetVersion: {
        assetVersionId: id(9),
        assetId: id(8),
        version: 1,
        objectEvidenceReference: id(15),
        providerObjectVersion: id(16),
        byteSize: session.declaredByteSize,
        checksum: "sha256:" + "a".repeat(64),
        contentType: session.declaredContentType,
        checkState: "Quarantined",
        readinessState: "Pending",
        createdAt: "2026-10-03T12:00:01.000Z",
      },
      audit: audit(true),
    },
  });
  if (create.action !== "CreateUpload" || final.action !== "FinalizeAsset")
    throw Error("Invalid controlled fixture");
  const upload = {
    profile: "S3_IMAGE_UPLOAD_V1",
    requestDigest: "sha256:" + "b".repeat(64),
    commandDigest: mediaUploadStorageIntentDigest(create),
    config,
    key: "quarantine/" + "c".repeat(64),
    checksum: final.input.assetVersion.checksum,
  };
  const binding = {
    profile: "S3_IMAGE_FINALIZED_V1",
    requestDigest: "sha256:" + "d".repeat(64),
    commandDigest: mediaUploadStorageIntentDigest(final),
    uploadBindingDigest: digest(upload),
    object: {
      bucket: config.bucket,
      key: upload.key,
      versionId: "opaque/S3+version.1",
      etag: "opaque-etag-2",
      objectEvidenceReference: final.input.assetVersion.objectEvidenceReference,
      providerObjectVersion: final.input.assetVersion.providerObjectVersion,
    },
    observedAt: "2026-10-03T12:00:01.100Z",
  };
  const event = {
    version: "0",
    id: "guardduty-event-1",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    source: "aws.guardduty",
    account: config.accountId,
    region: config.region,
    time: "2026-10-03T12:02:00Z",
    resources: [config.protectionPlanArn],
    detail: {
      schemaVersion: "1.0",
      scanStatus: "COMPLETED",
      resourceType: "S3_OBJECT",
      s3ObjectDetails: {
        bucketName: binding.object.bucket,
        objectKey: binding.object.key,
        versionId: binding.object.versionId,
        eTag: binding.object.etag,
        s3Throttled: true,
      },
      scanResultDetails: {
        scanResultStatus: "NO_THREATS_FOUND",
        threats: null,
        statusReasons: null,
      },
    },
  };
  const row = {
    final_binding: binding,
    final_digest: digest(binding),
    final_command: final,
    final_result: mediaUploadStorageResult(final),
    final_intent_digest: mediaUploadStorageIntentDigest(final),
    final_recorded_at: "2026-10-03T12:00:01.200Z",
    upload_binding: upload,
    upload_digest: digest(upload),
    create_command: create,
    create_result: mediaUploadStorageResult(create),
    create_intent_digest: mediaUploadStorageIntentDigest(create),
    create_recorded_at: "2026-10-03T12:00:00.100Z",
    session: final.input.closedSession,
    asset_version: final.input.assetVersion,
    current_asset: final.input.asset,
    coherent: true,
  };
  return { config, create, final, upload, binding, event, row };
}
function harness(row: unknown) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const state: { rows: readonly unknown[]; beforeReturn?: () => void; failure?: Error } = {
    rows: [row],
  };
  const tx: MediaPersistenceTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      state.beforeReturn?.();
      if (state.failure) throw state.failure;
      return { rows: state.rows as readonly Row[] };
    },
  };
  return { tx, state, calls };
}

it("recovers the exact original source in one scoped six-table statement without reusing today's Asset pointer", async () => {
  const f = fixture(),
    h = harness({
      ...f.row,
      current_asset: { ...f.row.current_asset, version: 4, currentVersionReference: id(90) },
    });
  const result = await loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event);
  expect(result.source).toEqual({
    tenantReference: f.config.tenantReference,
    session: f.final.input.closedSession,
    asset: f.final.input.asset,
    assetVersion: f.final.input.assetVersion,
    object: f.binding.object,
    scanEvent: f.event,
  });
  expect(result.source.asset.version).toBe(1);
  expect(result.source.asset.currentVersionReference).toBeNull();
  expect(result.sourceBindingDigest).toBe(digest(f.binding));
  expect(Object.isFrozen(result.source.scanEvent)).toBe(true);
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]?.values).toEqual([id(1), id(2), id(3), id(9)]);
  // SQL is exercised against actual PostgreSQL by the owning integration case;
  // this controlled test checks the scope and source acquisition contract only.
  for (const name of [
    "finalized_object_binding",
    "upload_object_binding",
    "operation_record",
    "upload_session",
    "asset_version",
    "asset",
  ])
    expect(h.calls[0]?.sql).toContain("bop_media." + name);
  expect(h.calls[0]?.sql).toContain("store_id IS NOT DISTINCT FROM $3");
  expect(h.calls[0]?.sql).not.toContain("FOR UPDATE");
});

it.each([{ rows: [] }, { rows: [fixture().row, fixture().row] }])(
  "rejects absent or nonunique source rows",
  async ({ rows }) => {
    const f = fixture(),
      h = harness(f.row);
    h.state.rows = rows;
    await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
      unavailable,
    );
  },
);

it.each(["final_digest", "upload_digest", "final_intent_digest", "create_intent_digest"] as const)(
  "rejects a changed %s",
  async (key) => {
    const f = fixture(),
      h = harness({ ...f.row, [key]: "sha256:" + "f".repeat(64) });
    await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
      unavailable,
    );
  },
);

it.each(["final_result", "create_result", "session", "asset_version"] as const)(
  "rejects corrupt immutable %s without trusting the SQL coherence boolean",
  async (key) => {
    const f = fixture(),
      h = harness({ ...f.row, [key]: { ...f.row[key], unexpected: true } });
    await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
      unavailable,
    );
  },
);

it("rejects mismatched indexed scope/Actor/action/identity or an incomplete binding origin", async () => {
  const f = fixture(),
    h = harness({ ...f.row, coherent: false });
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
  h.state.rows = [{ ...f.row, final_command: f.create }];
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
  h.state.rows = [{ ...f.row, final_binding: { ...f.binding, uploadBindingDigest: digest({}) } }];
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
});

it("rejects changed immutable Asset ownership while allowing only current root/pointer differences", async () => {
  const f = fixture(),
    h = harness({
      ...f.row,
      current_asset: { ...f.row.current_asset, ownerReference: id(91), version: 3 },
    });
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
});

it("rejects a consistently rehashed locator transplanted away from the original upload", async () => {
  const f = fixture(),
    altered = {
      ...f.binding,
      object: { ...f.binding.object, key: "quarantine/" + "e".repeat(64) },
    },
    h = harness({ ...f.row, final_binding: altered, final_digest: digest(altered) });
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
});

it("binds source lookup/config and immutable Create/Finalize session metadata", async () => {
  const f = fixture(),
    h = harness(f.row);
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(99), f.event)).rejects.toThrow(
    unavailable,
  );
  await expect(
    loadMediaImageProcessingSource(h.tx, { ...f.config, tenantReference: id(99) }, id(9), f.event),
  ).rejects.toThrow(unavailable);
  const create = parseMediaUploadStorageCommand({
    ...f.create,
    input: { ...f.create.input, session: { ...f.create.input.session, purpose: "MENU_IMAGE" } },
  });
  const upload = { ...f.upload, commandDigest: mediaUploadStorageIntentDigest(create) };
  h.state.rows = [
    {
      ...f.row,
      create_command: create,
      create_result: mediaUploadStorageResult(create),
      create_intent_digest: mediaUploadStorageIntentDigest(create),
      upload_binding: upload,
      upload_digest: digest(upload),
    },
  ];
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
});

it.each([
  { create_recorded_at: "2026-10-03T11:59:59.000Z" },
  { final_recorded_at: "2026-10-03T12:00:01.050Z" },
  { final_recorded_at: "2026-10-03T12:15:00.000Z" },
])("keeps original receipt and Provider observation timing coherent: %j", async (change) => {
  const f = fixture(),
    h = harness({ ...f.row, ...change });
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
});

it("uses the same official scan/locator parser without treating JSON as current permission", async () => {
  const f = fixture(),
    h = harness(f.row);
  for (const event of [
    { clean: true },
    { ...f.event, account: "999988887777" },
    { ...f.event, resources: ["foreign-plan"] },
    {
      ...f.event,
      detail: {
        ...f.event.detail,
        s3ObjectDetails: { ...f.event.detail.s3ObjectDetails, versionId: "other-version" },
      },
    },
    { ...f.event, detail: { ...f.event.detail, scanStatus: "FAILED" } },
  ])
    await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), event)).rejects.toThrow(
      unavailable,
    );
});

it("captures mutable configuration/event before SQL and refuses a replaced query port", async () => {
  const f = fixture(),
    h = harness(f.row),
    config = { ...f.config },
    event = structuredClone(f.event);
  h.state.beforeReturn = () => {
    config.accountId = "999988887777";
    event.detail.s3ObjectDetails.versionId = "changed";
  };
  expect(
    (await loadMediaImageProcessingSource(h.tx, config, id(9), event)).source.scanEvent,
  ).toEqual(f.event);
  h.state.beforeReturn = () => {
    h.tx.query = async () => ({ rows: [] });
  };
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
});

it("does not execute input/row accessors or expose raw storage errors and locators", async () => {
  const f = fixture(),
    h = harness(f.row),
    getter = vi.fn(() => f.event.detail);
  const event = Object.defineProperty({ ...f.event }, "detail", { enumerable: true, get: getter });
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), event)).rejects.toThrow(
    unavailable,
  );
  expect(getter).not.toHaveBeenCalled();
  expect(h.calls).toHaveLength(0);
  h.state.rows = [
    Object.defineProperty({ ...f.row }, "final_binding", { enumerable: true, get: getter }),
  ];
  await expect(loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event)).rejects.toThrow(
    unavailable,
  );
  expect(getter).not.toHaveBeenCalled();
  h.state.failure = Error("secret provider credential and raw quarantine locator");
  const result = await loadMediaImageProcessingSource(h.tx, f.config, id(9), f.event).catch(
    (error: unknown) => error,
  );
  expect(result).toEqual(unavailable);
  expect(result).not.toHaveProperty("cause");
});
