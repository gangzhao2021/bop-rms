import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
} from "../contracts/media.js";
import { buildMediaImageScanAdmission } from "../contracts/media-image-scan-admission.js";
import {
  mediaPublicationReadFields,
  parseMediaPublicationReadRequest,
  parseMediaPublicationReadSnapshot,
  parseMediaOptionSetPublicationReadRequest,
  parseMediaOptionSetPublicationReadSnapshot,
} from "../contracts/media-publication-read.js";
import {
  createMediaImagePromotionPlan,
  mediaImagePromotionPlanDigest,
  parseMediaImagePromotionResult,
} from "../infrastructure/processing/media-image-promotion.js";
import {
  createPostgresMediaPublicationReadSource,
  createPostgresMediaOptionSetPublicationReadSource,
  type MediaOptionSetPublicationReadAuthorityInput,
  type MediaPublicationReadAuthorityInput,
} from "../infrastructure/persistence/media-publication-read-store.js";
import { loadMediaImageProcessingSource } from "../infrastructure/persistence/media-image-processing-source.js";
import { parseS3QuarantineImageConfig } from "../infrastructure/provider/s3-quarantine-image-source.js";
import type { MediaPersistenceTransaction } from "../infrastructure/persistence/media-upload-store.js";

vi.mock("../infrastructure/persistence/media-image-processing-source.js", () => ({
  loadMediaImageProcessingSource: vi.fn(),
}));
const id = (n: number) => "019a2421-0032-7000-8000-" + n.toString(16).padStart(12, "0"),
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v)),
  checksum = (n: number) => "sha256:" + n.toString(16).padStart(64, "0"),
  at = "2026-10-03T12:03:00.000Z",
  until = "2026-10-03T12:03:05.000Z",
  unavailable = { code: "MEDIA_PUBLICATION_READ_UNAVAILABLE" };

function fixture() {
  // Real owning parsers over synthetic immutable facts. This fixture is not a
  // scanner, cloud grant or proof of byte processing; native acceptance joins
  // the actual persisted upload, admission and completed promotion chain.
  const scope = createMediaScope({
    kind: "Brand",
    brandReference: id(2),
    storeReference: null,
  } as Parameters<typeof createMediaScope>[0]);
  const config = parseS3QuarantineImageConfig({
    tenantReference: id(1),
    scope,
    region: "ca-central-1",
    accountId: "111122223333",
    bucket: "synthetic-quarantine-images",
    quarantinePrefix: "quarantine/",
    kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    protectionPlanArn:
      "arn:aws:guardduty:ca-central-1:111122223333:malware-protection-plan/synthetic123",
  });
  const session = createUploadSession({
    uploadSessionId: id(8),
    grantReference: id(9),
    actorReference: id(10),
    purpose: "PRODUCT_IMAGE",
    scope,
    mediaKind: "Image",
    declaredContentType: "image/png",
    declaredByteSize: 1234,
    ownerType: "PRODUCT",
    ownerReference: id(11),
    classification: "Public",
    state: "Finalized",
    version: 2,
    createdAt: "2026-10-03T12:00:00.000Z",
    expiresAt: "2026-10-03T12:15:00.000Z",
  } as Parameters<typeof createUploadSession>[0]);
  const asset = createMediaAsset({
    assetId: id(5),
    purpose: session.purpose,
    scope,
    mediaKind: "Image",
    ownerType: session.ownerType,
    ownerReference: session.ownerReference,
    classification: session.classification,
    currentVersionReference: null,
    version: 1,
  } as Parameters<typeof createMediaAsset>[0]);
  const assetVersion = createMediaAssetVersion({
    assetVersionId: id(6),
    assetId: id(5),
    version: 1,
    objectEvidenceReference: id(12),
    providerObjectVersion: id(13),
    byteSize: 1234,
    checksum: checksum(2),
    contentType: "image/png",
    checkState: "Quarantined",
    readinessState: "Pending",
    createdAt: "2026-10-03T12:00:01.000Z",
  } as Parameters<typeof createMediaAssetVersion>[0]);
  const object = {
    bucket: config.bucket,
    key: "quarantine/" + "a".repeat(64),
    versionId: "opaque/source-version",
    etag: "opaque-source-etag",
    objectEvidenceReference: assetVersion.objectEvidenceReference,
    providerObjectVersion: assetVersion.providerObjectVersion,
  };
  const scanEvent = {
    version: "0",
    id: "scan-event-1",
    source: "aws.guardduty",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    account: config.accountId,
    region: config.region,
    time: "2026-10-03T12:01:00Z",
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
  };
  const source = { tenantReference: id(1), session, asset, assetVersion, object, scanEvent },
    sourceBindingDigest = checksum(1),
    deploymentConfigurationDigest = checksum(40);
  const admission = buildMediaImageScanAdmission({
    profile: "MEDIA_IMAGE_SCAN_ADMISSION_V1",
    admissionReference: id(20),
    tenantReference: id(1),
    scope,
    workloadReference: id(21),
    deploymentConfigurationDigest,
    quarantineConfigurationDigest: hash(config),
    providerAccount: config.accountId,
    region: config.region,
    protectionPlanArn: config.protectionPlanArn,
    eventId: scanEvent.id,
    scanEventDigest: hash(scanEvent),
    scanEvent,
    sourceAssetVersionReference: assetVersion.assetVersionId,
    sourceBindingDigest,
    object,
    transport: {
      profile: "GUARDDUTY_SQS_DELIVERY_V1",
      deploymentConfigurationDigest,
      queueArn: "arn:aws:sqs:ca-central-1:111122223333:synthetic-scans",
      queueCreatedAt: "2026-10-03T11:00:00.000Z",
      queuePolicyDigest: checksum(41),
      bodyDigest: hash(scanEvent),
      messageId: "message-1",
      sentAt: "2026-10-03T12:01:00.000Z",
      receivedAt: "2026-10-03T12:01:00.100Z",
    },
    admittedAt: "2026-10-03T12:01:00.200Z",
    auditReference: id(22),
    correlationId: id(23),
  });
  const plan = createMediaImagePromotionPlan({
    operationReference: id(4),
    tenantReference: id(1),
    scope,
    assetReference: asset.assetId,
    sourceAssetVersionReference: assetVersion.assetVersionId,
    targetAssetVersionReference: id(7),
    expectedAssetVersion: 1,
    sourceBindingDigest,
    destination: {
      accountId: config.accountId,
      bucket: "synthetic-clean-images",
      cleanPrefix: "clean/",
      kmsKeyArn: config.kmsKeyArn,
    },
  });
  const intent = {
    profile: "MEDIA_IMAGE_PROCESSING_INTENT_V1",
    operationReference: plan.operationReference,
    tenantReference: id(1),
    scope,
    systemActorReference: id(21),
    sourceBindingDigest,
    source,
    plan,
    createdAt: "2026-10-03T12:01:01.000Z",
    auditId: id(24),
    correlationId: id(23),
    admissionReference: admission.admissionReference,
  };
  const result = parseMediaImagePromotionResult(
    {
      profile: "PUBLIC_IMAGE_RESULT_V1",
      operationReference: plan.operationReference,
      planDigest: mediaImagePromotionPlanDigest(plan),
      sourceEvidence: {
        ...object,
        tenantReference: id(1),
        scope,
        uploadSessionReference: session.uploadSessionId,
        assetReference: asset.assetId,
        assetVersionReference: assetVersion.assetVersionId,
        byteSize: assetVersion.byteSize,
        checksum: assetVersion.checksum,
        kmsKeyArn: config.kmsKeyArn,
      },
      scanEvidence: {
        eventId: scanEvent.id,
        eventTime: scanEvent.time,
        accountId: config.accountId,
        region: config.region,
        protectionPlanArn: config.protectionPlanArn,
        result: "NO_THREATS_FOUND",
        s3Throttled: false,
      },
      original: {
        ...plan.original,
        bucket: plan.destination.bucket,
        versionId: "original-version",
        etag: "original-etag",
        contentType: "image/png",
        byteSize: assetVersion.byteSize,
        checksum: assetVersion.checksum,
      },
      renditions: plan.renditions.map((p, index) => ({
        ...p,
        bucket: plan.destination.bucket,
        versionId: "rendition-version-" + index,
        etag: "rendition-etag-" + index,
        height: p.width / 2,
        byteSize: 2000 + index,
        checksum: checksum(index + 3),
      })),
      completedAt: "2026-10-03T12:02:00.000Z",
    },
    plan,
    source,
  );
  const representative = result.renditions[4];
  if (!representative) throw Error("synthetic representative absent");
  const completedAt = "2026-10-03T12:02:00.100Z",
    completedAsset = createMediaAsset({
      ...asset,
      currentVersionReference: plan.targetAssetVersionReference,
      version: 2,
    } as Parameters<typeof createMediaAsset>[0]),
    completedVersion = createMediaAssetVersion({
      assetVersionId: plan.targetAssetVersionReference,
      assetId: asset.assetId,
      version: 2,
      objectEvidenceReference: representative.objectEvidenceReference,
      providerObjectVersion: representative.providerObjectVersion,
      byteSize: representative.byteSize,
      checksum: representative.checksum,
      contentType: representative.contentType,
      checkState: "Clean",
      readinessState: "Ready",
      createdAt: completedAt,
    } as Parameters<typeof createMediaAssetVersion>[0]);
  const row: Record<string, unknown> = {
    asset: completedAsset,
    version: completedVersion,
    coherent: true,
    intent,
    intent_digest: hash(intent),
    plan_digest: mediaImagePromotionPlanDigest(plan),
    completion: result,
    completion_digest: hash(result),
    completed_asset: completedAsset,
    completed_version: completedVersion,
    completed_at: completedAt,
    source_config: config,
    admission,
    admission_digest: admission.digest,
    provenance_coherent: true,
  };
  const request = parseMediaPublicationReadRequest({
    profile: "MediaPublicationReadRequestV1",
    intentKind: "PublicationV2",
    tenantReference: id(1),
    scope,
    actorReference: id(30),
    actorKind: "User",
    operationReference: id(31),
    originalIntentDigest: checksum(31),
    productReference: id(32),
    versionReference: id(33),
    aggregateSnapshotDigest: checksum(32),
    contentDigest: checksum(33),
    configurationDigest: checksum(34),
    replacementIntentDigest: checksum(35),
    references: [
      {
        mediaReference: id(34),
        assetReference: asset.assetId,
        assetVersionReference: completedVersion.assetVersionId,
        cropReference: null,
        focusReference: null,
      },
    ],
    observedAt: at,
    validUntil: until,
  });
  return {
    config,
    source,
    sourceBindingDigest,
    admission,
    intent,
    result,
    completedAsset,
    completedVersion,
    row,
    request,
  };
}
function harness() {
  const f = fixture(),
    guards: { guard: () => Promise<void>; final: () => void }[] = [],
    calls: { sql: string; values: readonly unknown[] }[] = [],
    holds: MediaPublicationReadAuthorityInput[] = [];
  const state = {
    now: at,
    deadline: until,
    allowed: true,
    missing: false,
    row: f.row,
    renditions: f.result.renditions.map((snapshot) => ({
      snapshot: snapshot as unknown,
      coherent: true,
    })),
    context: {
      tenant_reference: id(1),
      brand_reference: id(2),
      store_reference: null as string | null,
      isolation: "read committed",
    },
    beforeQuery: null as null | ((sql: string) => Promise<void>),
    onHold: null as null | (() => Promise<void>),
    onRegister: null as null | (() => Promise<void>),
  };
  const tx: MediaPersistenceTransaction = {
    query: async <Row>(sql: string, values: readonly unknown[]) => {
      calls.push({ sql, values });
      await state.beforeQuery?.(sql);
      const rows = sql.startsWith("SELECT current_setting")
        ? [state.context]
        : sql.includes("FROM bop_media.asset_version v JOIN")
          ? state.missing
            ? []
            : [state.row]
          : sql.includes("FROM bop_media.image_rendition")
            ? state.renditions
            : null;
      if (!rows) throw Error("unexpected controlled SQL");
      return { rows: rows as readonly Row[] };
    },
  };
  const options = {
    tenantReference: id(1),
    scope: f.config.scope,
    actorReference: id(30),
    actorKind: "User" as "User" | "System",
    clock: { now: () => state.now },
    authority: {
      async holdUntilTransactionCompletes(
        actual: MediaPersistenceTransaction,
        input: MediaPublicationReadAuthorityInput,
      ) {
        expect(actual).toBe(tx);
        holds.push(input);
        await state.onHold?.();
        if (!state.allowed) throw Error("controlled current denial");
        return { observedAt: input.request.observedAt, validUntil: state.deadline };
      },
    },
    async registerBeforeCommit(
      actual: MediaPersistenceTransaction,
      guard: () => Promise<void>,
      final: () => void,
    ) {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
      await state.onRegister?.();
    },
  };
  const source = createPostgresMediaPublicationReadSource(options);
  vi.mocked(loadMediaImageProcessingSource)
    .mockReset()
    .mockImplementation(async (_tx, config, reference, event) => {
      void _tx;
      expect(config).toEqual(f.config);
      expect(reference).toBe(f.source.assetVersion.assetVersionId);
      expect(event).toEqual(f.source.scanEvent);
      return { source: f.source, sourceBindingDigest: f.sourceBindingDigest };
    });
  return {
    f,
    source,
    tx,
    options,
    state,
    guards,
    calls,
    holds,
    read(request = f.request) {
      return source.withCurrentReferences(tx, request, async (snapshot, actual) => {
        expect(actual).toBe(tx);
        return snapshot;
      });
    },
    async flush() {
      for (const g of guards) await g.guard();
      for (const g of guards) g.final();
    },
  };
}

describe("owning pinned Media publication read (controlled SQL and current access authority)", () => {
  it("joins exact completed provenance and six renditions, emits no locators, and retains current access through commit", async () => {
    const h = harness(),
      snapshot = await h.read();
    await h.flush();
    expect(snapshot.references[0]).toMatchObject({
      status: "Ready",
      assetVersion: h.f.completedVersion,
    });
    expect(parseMediaPublicationReadSnapshot(snapshot)).toEqual(snapshot);
    expect(h.holds).toHaveLength(2);
    expect(h.holds[0]).toEqual({
      request: h.f.request,
      action: "media.asset.access",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ",
      requiredFields: mediaPublicationReadFields,
    });
    const output = JSON.stringify(snapshot);
    for (const privateValue of [
      "synthetic-clean-images",
      "quarantine/",
      "clean/",
      "opaque/source-version",
      "rendition-version-",
      "currentVersionReference",
    ])
      expect(output).not.toContain(privateValue);
    expect(Object.isFrozen(snapshot.references[0])).toBe(true);
    expect(h.calls.some((c) => /\b(?:INSERT|UPDATE|DELETE|set_config)\b/u.test(c.sql))).toBe(false);
  });
  it("keeps the old pin and relevant digest stable after the mutable current root advances", async () => {
    const h = harness(),
      original = await h.read();
    h.state.row = {
      ...h.state.row,
      asset: { ...h.f.completedAsset, version: 3, currentVersionReference: id(90) },
    };
    h.state.now = "2026-10-03T12:03:01.000Z";
    const next = await h.read(
      parseMediaPublicationReadRequest({
        ...h.f.request,
        operationReference: id(91),
        originalIntentDigest: checksum(91),
        aggregateSnapshotDigest: checksum(92),
        observedAt: h.state.now,
      }),
    );
    expect(next.references).toEqual(original.references);
    expect(next.relevantReferenceDigest).toBe(original.relevantReferenceDigest);
    expect(next.digest).not.toBe(original.digest);
    await h.flush();
  });
  it("does not impose consuming Product ownership equality on the Media owner", async () => {
    const h = harness();
    expect(h.f.source.asset.ownerReference).not.toBe(h.f.request.productReference);
    expect((await h.read()).references[0]?.status).toBe("Ready");
    await h.flush();
  });
  it("allows empty references with real current authority and an explicit empty source snapshot", async () => {
    const h = harness(),
      snapshot = await h.read(parseMediaPublicationReadRequest({ ...h.f.request, references: [] }));
    expect(snapshot.references).toEqual([]);
    expect(h.calls).toHaveLength(1);
    expect(loadMediaImageProcessingSource).not.toHaveBeenCalled();
    await h.flush();
    expect(h.holds).toHaveLength(2);
  });
  it("round trips the public maximum of 100 Ready references without truncation or repeated pin reads", async () => {
    const h = harness(),
      first = h.f.request.references[0];
    if (!first) throw Error("fixture missing");
    const request = parseMediaPublicationReadRequest({
      ...h.f.request,
      references: Array.from({ length: 100 }, (_, i) => ({
        ...first,
        mediaReference: id(1000 + i),
      })),
    });
    const snapshot = await h.read(request);
    expect(snapshot.references).toHaveLength(100);
    expect(snapshot.references.every((r) => r.status === "Ready")).toBe(true);
    expect(parseMediaPublicationReadSnapshot(snapshot)).toEqual(snapshot);
    expect(h.calls).toHaveLength(3);
    expect(loadMediaImageProcessingSource).toHaveBeenCalledTimes(1);
    await h.flush();
  });
  it("returns a truthful unavailable result for missing or quarantined pins", async () => {
    const h = harness();
    h.state.missing = true;
    expect((await h.read()).references[0]).toMatchObject({
      status: "Unavailable",
      reason: "NotFound",
    });
    h.state.missing = false;
    h.state.row = { ...h.state.row, version: h.f.source.assetVersion };
    const reference = h.f.request.references[0];
    if (!reference) throw Error("fixture missing");
    expect(
      (
        await h.read(
          parseMediaPublicationReadRequest({
            ...h.f.request,
            references: [
              { ...reference, assetVersionReference: h.f.source.assetVersion.assetVersionId },
            ],
          }),
        )
      ).references[0],
    ).toMatchObject({ status: "Unavailable", reason: "NotReady" });
    expect(loadMediaImageProcessingSource).not.toHaveBeenCalled();
    await h.flush();
  });
  it.each(["cropReference", "focusReference"] as const)(
    "never fabricates a %s adjustment result",
    async (field) => {
      const h = harness(),
        reference = h.f.request.references[0];
      if (!reference) throw Error("fixture missing");
      const result = await h.read(
        parseMediaPublicationReadRequest({
          ...h.f.request,
          references: [{ ...reference, [field]: id(95) }],
        }),
      );
      expect(result.references[0]).toMatchObject({
        status: "Unavailable",
        reason: "UnsupportedAdjustment",
      });
      expect(h.calls).toHaveLength(1);
      await h.flush();
    },
  );
  it.each([
    { name: "missing completion", change: { completion: null } },
    { name: "missing admission", change: { admission: null } },
    { name: "incoherent provenance", change: { provenance_coherent: false } },
    { name: "wrong intent digest", change: { intent_digest: checksum(99) } },
    { name: "wrong result digest", change: { completion_digest: checksum(99) } },
    { name: "wrong admission digest", change: { admission_digest: checksum(99) } },
    { name: "missing original config", change: { source_config: null } },
  ])(
    "throws for $name instead of converting a broken Ready source into missing",
    async ({ change }) => {
      const h = harness(),
        callback = vi.fn();
      h.state.row = { ...h.state.row, ...change };
      await expect(
        h.source.withCurrentReferences(h.tx, h.f.request, callback),
      ).rejects.toMatchObject(unavailable);
      expect(callback).not.toHaveBeenCalled();
      await expect(h.flush()).rejects.toMatchObject(unavailable);
    },
  );
  it.each(["missing", "extra", "changed", "incoherent"])(
    "rejects %s required rendition rows",
    async (mode) => {
      const h = harness();
      if (mode === "missing") h.state.renditions.pop();
      if (mode === "extra") {
        const row = h.state.renditions[0];
        if (!row) throw Error("fixture missing");
        h.state.renditions.push(row);
      }
      if (mode === "changed")
        h.state.renditions[0] = {
          snapshot: { ...h.f.result.renditions[0], checksum: checksum(99) },
          coherent: true,
        };
      if (mode === "incoherent") {
        const row = h.state.renditions[0];
        if (!row) throw Error("fixture missing");
        row.coherent = false;
      }
      await expect(h.read()).rejects.toMatchObject(unavailable);
      await expect(h.flush()).rejects.toMatchObject(unavailable);
    },
  );
  it("rejects transplanted source, ownership metadata and actual RLS mismatch", async () => {
    const h = harness();
    h.state.row = { ...h.state.row, asset: { ...h.f.completedAsset, ownerReference: id(99) } };
    await expect(h.read()).rejects.toMatchObject(unavailable);
    const other = harness();
    other.state.context.store_reference = id(3);
    await expect(other.read()).rejects.toMatchObject(unavailable);
    expect(other.calls).toHaveLength(1);
    const source = harness();
    vi.mocked(loadMediaImageProcessingSource).mockResolvedValue({
      source: source.f.source,
      sourceBindingDigest: checksum(99),
    });
    await expect(source.read()).rejects.toMatchObject(unavailable);
  });
  it("treats SQL failure as bounded source failure and poisons a swallowed callback error", async () => {
    const h = harness();
    h.state.beforeQuery = async () => {
      throw Error("private database detail");
    };
    await expect(h.read()).rejects.toMatchObject(unavailable);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
    const callback = harness();
    await callback.source
      .withCurrentReferences(callback.tx, callback.f.request, async () => {
        throw Error("consumer failed");
      })
      .catch(() => undefined);
    await expect(callback.flush()).rejects.toMatchObject(unavailable);
  });
  it("preserves the earlier lease and refuses revoked access and later async expiry at global final phase", async () => {
    const h = harness();
    h.state.deadline = "2026-10-03T12:03:02.000Z";
    expect((await h.read()).validUntil).toBe(h.state.deadline);
    h.state.allowed = false;
    await expect(h.flush()).rejects.toMatchObject(unavailable);
    const expired = harness();
    await expired.read();
    expired.guards.push({
      guard: async () => {
        expired.state.now = until;
      },
      final: () => {
        /* Unrelated host guard has no lease. */
      },
    });
    await expect(expired.flush()).rejects.toMatchObject(unavailable);
  });
  it("does not open a new lease after slow registration or allow caught clock rollback", async () => {
    const delayed = harness();
    delayed.state.onRegister = async () => {
      delayed.state.now = until;
    };
    await expect(delayed.read()).rejects.toMatchObject(unavailable);
    expect(delayed.holds).toHaveLength(0);
    const backward = harness();
    await backward.read();
    backward.state.now = "2026-10-03T12:02:59.999Z";
    await backward.flush().catch(() => undefined);
    backward.state.now = at;
    await expect(backward.flush()).rejects.toMatchObject(unavailable);
  });
  it("captures authority/clock ports, refuses tx query replacement and caught same-tx reentry", async () => {
    const h = harness();
    h.options.clock.now = () => until;
    h.options.authority.holdUntilTransactionCompletes = async () => {
      throw Error("changed port");
    };
    await h.read();
    await h.flush();
    const changed = harness();
    await changed.read();
    changed.tx.query = async () => ({ rows: [] });
    await expect(changed.flush()).rejects.toMatchObject(unavailable);
    const nested = harness();
    let attempted = false;
    nested.state.onHold = async () => {
      if (!attempted) {
        attempted = true;
        await nested.read().catch(() => undefined);
      }
    };
    await expect(nested.read()).rejects.toMatchObject(unavailable);
    await expect(nested.flush()).rejects.toMatchObject(unavailable);
  });
  it("keeps Ack intent distinct and never accepts System Ack as a User request", async () => {
    const h = harness(),
      ack = parseMediaPublicationReadRequest({
        ...h.f.request,
        intentKind: "WarningAcknowledgementV1",
        originalIntentDigest: checksum(80),
      });
    expect((await h.read(ack)).request).toEqual(ack);
    await h.flush();
    expect(() => parseMediaPublicationReadRequest({ ...ack, actorKind: "System" })).toThrow();
  });
});

describe("closed Media publication read contract", () => {
  it.each([
    { field: "tenantReference", value: id(90) },
    { field: "actorReference", value: id(91) },
    { field: "scope", value: { kind: "Brand", brandReference: id(92), storeReference: null } },
  ])("refuses foreign $field before SQL", async ({ field, value }) => {
    const h = harness();
    await expect(
      h.read(parseMediaPublicationReadRequest({ ...h.f.request, [field]: value })),
    ).rejects.toMatchObject(unavailable);
    expect(h.calls).toHaveLength(0);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it("rejects getter/extra/duplicate references and leases exceeding the original five seconds", () => {
    const f = fixture(),
      getter = vi.fn(() => f.request.references),
      value = { ...f.request };
    Object.defineProperty(value, "references", { enumerable: true, get: getter });
    expect(() => parseMediaPublicationReadRequest(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    for (const v of [
      { ...f.request, authorized: true },
      { ...f.request, references: [...f.request.references, ...f.request.references] },
      { ...f.request, validUntil: "2026-10-03T12:03:05.001Z" },
    ])
      expect(() => parseMediaPublicationReadRequest(v)).toThrow();
  });
  it("binds exact ready references and source hash without exposing a mutable caller snapshot", async () => {
    const h = harness(),
      snapshot = await h.read(),
      reference = snapshot.references[0];
    if (!reference) throw Error("fixture missing");
    for (const value of [
      { ...snapshot, digest: checksum(99) },
      { ...snapshot, relevantReferenceDigest: checksum(99) },
      { ...snapshot, references: [{ ...reference, assetVersionReference: id(99) }] },
    ])
      expect(() => parseMediaPublicationReadSnapshot(value)).toThrow();
    h.state.row.version = { ...h.f.completedVersion, checksum: checksum(90) };
    expect(snapshot.references[0]).toEqual(reference);
    await h.flush();
  });
});

function optionSetHarness() {
  const h = harness(),
    holds: MediaOptionSetPublicationReadAuthorityInput[] = [];
  const request = parseMediaOptionSetPublicationReadRequest({
    profile: "MediaOptionSetPublicationReadRequestV1",
    tenantReference: id(1),
    scope: h.f.config.scope,
    actorReference: id(30),
    actorKind: "User",
    operationReference: id(300),
    originalIntentDigest: checksum(301),
    optionSetReference: id(302),
    versionReference: id(303),
    expectedAggregateVersion: 2,
    sourceDigest: checksum(304),
    contentDigest: checksum(305),
    configurationDigest: checksum(306),
    graphDigest: checksum(307),
    activationAt: "2026-10-03T12:04:00.000Z",
    references: h.f.request.references,
    observedAt: at,
    validUntil: until,
  });
  const source = createPostgresMediaOptionSetPublicationReadSource({
    ...h.options,
    actorKind: "User",
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(h.tx);
        holds.push(input);
        await h.state.onHold?.();
        if (!h.state.allowed) throw Error("controlled current denial");
        return { observedAt: input.request.observedAt, validUntil: h.state.deadline };
      },
    },
  });
  return {
    ...h,
    request,
    source,
    holds,
    read(value = request) {
      return source.withCurrentReferences(h.tx, value, async (snapshot, actual) => {
        expect(actual).toBe(h.tx);
        return snapshot;
      });
    },
  };
}

describe("fixed owning Option Set publication Media admission", () => {
  it("binds the complete original Option tuple to actual nonempty Ready provenance with fixed authority and no Product disguise", async () => {
    const h = optionSetHarness(),
      snapshot = await h.read();
    await h.flush();
    expect(parseMediaOptionSetPublicationReadSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.request).toEqual(h.request);
    expect(snapshot.references[0]).toMatchObject({
      status: "Ready",
      assetVersion: h.f.completedVersion,
      asset: {
        purpose: h.f.completedAsset.purpose,
        ownerType: h.f.completedAsset.ownerType,
        ownerReference: h.f.completedAsset.ownerReference,
        classification: h.f.completedAsset.classification,
      },
    });
    // Existing synthetic asset metadata is retained; this is not Option ownership,
    // Catalog reference eligibility, cloud authorization or scanner evidence.
    expect(h.holds).toHaveLength(2);
    for (const hold of h.holds)
      expect(hold).toEqual({
        request: h.request,
        action: "media.asset.access",
        purposeCode: "CATALOG_OPTION_SET_PUBLICATION_MEDIA_READ",
        requiredFields: mediaPublicationReadFields,
      });
    const json = JSON.stringify(snapshot);
    for (const forbidden of [
      "productReference",
      "replacementIntentDigest",
      "synthetic-clean-images",
      "quarantine/",
      "clean/",
      "rendition-version-",
    ])
      expect(json).not.toContain(forbidden);
    expect(Object.isFrozen(snapshot.request)).toBe(true);
    expect(Object.isFrozen(snapshot.references)).toBe(true);
    expect(h.calls.some((c) => /\b(?:INSERT|UPDATE|DELETE|set_config)\b/u.test(c.sql))).toBe(false);
    expect(() => parseMediaPublicationReadRequest(h.request)).toThrow();
    expect(() => parseMediaOptionSetPublicationReadRequest(h.f.request)).toThrow();
    expect(() => parseMediaPublicationReadSnapshot(snapshot)).toThrow();
  });
  it.each([
    { productReference: id(50) },
    { purposeCode: "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ" },
    { profile: "MediaPublicationReadRequestV1" },
    { actorKind: "System" },
    { expectedAggregateVersion: 0 },
    { expectedAggregateVersion: 2147483648 },
    { expectedAggregateVersion: 1.5 },
    { optionSetReference: "invalid" },
    { versionReference: "invalid" },
    { operationReference: "invalid" },
    { sourceDigest: "invalid" },
    { contentDigest: "invalid" },
    { configurationDigest: "invalid" },
    { graphDigest: "invalid" },
    { originalIntentDigest: "invalid" },
    { activationAt: "2026-10-03T12:02:59.999Z" },
    { validUntil: "2026-10-03T12:03:05.001Z" },
    { validUntil: at },
    { references: [], extra: true },
  ])("refuses malformed or mixed original Option tuple %j", (change) => {
    const h = optionSetHarness();
    expect(() => parseMediaOptionSetPublicationReadRequest({ ...h.request, ...change })).toThrow();
  });
  it("binds every original tuple field into the snapshot digest and refuses changed or extra returned fields", async () => {
    const h = optionSetHarness(),
      snapshot = await h.read();
    for (const [field, value] of Object.entries({
      optionSetReference: id(600),
      versionReference: id(601),
      operationReference: id(602),
      expectedAggregateVersion: 3,
      sourceDigest: checksum(603),
      contentDigest: checksum(604),
      configurationDigest: checksum(605),
      graphDigest: checksum(606),
      originalIntentDigest: checksum(607),
      activationAt: "2026-10-03T12:05:00.000Z",
    })) {
      expect(() =>
        parseMediaOptionSetPublicationReadSnapshot({
          ...snapshot,
          request: { ...snapshot.request, [field]: value },
        }),
      ).toThrow();
    }
    expect(() =>
      parseMediaOptionSetPublicationReadSnapshot({ ...snapshot, eligibility: "Pass" }),
    ).toThrow();
    expect(() =>
      parseMediaOptionSetPublicationReadSnapshot({ ...snapshot, references: [] }),
    ).toThrow();
    await h.flush();
  });
  it("records genuine zero reference coverage without manufacturing Ready facts", async () => {
    const h = optionSetHarness(),
      snapshot = await h.read({ ...h.request, references: [] });
    expect(snapshot.references).toEqual([]);
    expect(parseMediaOptionSetPublicationReadSnapshot(snapshot)).toEqual(snapshot);
    expect(h.calls).toHaveLength(1);
    expect(loadMediaImageProcessingSource).not.toHaveBeenCalled();
    await h.flush();
  });
  it("bounds and deduplicates exact reference coverage without changing the actual asset pin", async () => {
    const h = optionSetHarness(),
      first = h.request.references[0];
    if (!first) throw Error("fixture reference missing");
    const references = Array.from({ length: 100 }, (_, i) => ({
      ...first,
      mediaReference: id(2000 + i),
    }));
    const snapshot = await h.read({ ...h.request, references });
    expect(snapshot.references).toHaveLength(100);
    expect(snapshot.references.every((r) => r.status === "Ready")).toBe(true);
    expect(parseMediaOptionSetPublicationReadSnapshot(snapshot)).toEqual(snapshot);
    expect(h.calls).toHaveLength(3);
    expect(loadMediaImageProcessingSource).toHaveBeenCalledTimes(1);
    expect(() =>
      parseMediaOptionSetPublicationReadRequest({
        ...h.request,
        references: [...references, { ...first, mediaReference: id(2200) }],
      }),
    ).toThrow();
    expect(() =>
      parseMediaOptionSetPublicationReadRequest({ ...h.request, references: [first, first] }),
    ).toThrow();
    await h.flush();
  });
  it.each(["cropReference", "focusReference"] as const)(
    "returns UnsupportedAdjustment for actual %s rather than inventing a rendition",
    async (field) => {
      const h = optionSetHarness(),
        first = h.request.references[0];
      if (!first) throw Error("fixture reference missing");
      const snapshot = await h.read({ ...h.request, references: [{ ...first, [field]: id(901) }] });
      expect(snapshot.references[0]).toMatchObject({
        status: "Unavailable",
        reason: "UnsupportedAdjustment",
      });
      expect(h.calls).toHaveLength(1);
      expect(loadMediaImageProcessingSource).not.toHaveBeenCalled();
      await h.flush();
    },
  );
  it("preserves actual missing and quarantined states, never upgrades them", async () => {
    const h = optionSetHarness();
    h.state.missing = true;
    expect((await h.read()).references[0]).toMatchObject({
      status: "Unavailable",
      reason: "NotFound",
    });
    await h.flush();
    const pending = optionSetHarness(),
      first = pending.request.references[0];
    if (!first) throw Error("fixture reference missing");
    pending.state.row = { ...pending.state.row, version: pending.f.source.assetVersion };
    const snapshot = await pending.read({
      ...pending.request,
      references: [
        { ...first, assetVersionReference: pending.f.source.assetVersion.assetVersionId },
      ],
    });
    expect(snapshot.references[0]).toMatchObject({ status: "Unavailable", reason: "NotReady" });
    expect(loadMediaImageProcessingSource).not.toHaveBeenCalled();
    await pending.flush();
  });
  it.each([
    { completion: null },
    { provenance_coherent: false },
    { admission_digest: checksum(99) },
    { coherent: false },
    { completion_digest: checksum(99) },
  ])(
    "refuses corrupt nonempty Ready source %j and poisons the original transaction",
    async (change) => {
      const h = optionSetHarness();
      h.state.row = { ...h.state.row, ...change };
      const work = vi.fn();
      await expect(h.source.withCurrentReferences(h.tx, h.request, work)).rejects.toMatchObject(
        unavailable,
      );
      expect(work).not.toHaveBeenCalled();
      await expect(h.flush()).rejects.toMatchObject(unavailable);
    },
  );
  it("rejects mismatched pin and scoped SQL provenance instead of emitting a false missing result", async () => {
    const h = optionSetHarness();
    h.state.row = { ...h.state.row, version: { ...h.f.completedVersion, assetVersionId: id(99) } };
    await expect(h.read()).rejects.toMatchObject(unavailable);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
    const wrongScope = optionSetHarness();
    wrongScope.state.context.store_reference = id(3);
    await expect(wrongScope.read()).rejects.toMatchObject(unavailable);
    await expect(wrongScope.flush()).rejects.toMatchObject(unavailable);
  });
  it("refuses current denial before any source query or callback", async () => {
    const h = optionSetHarness();
    h.state.allowed = false;
    const work = vi.fn();
    await expect(h.source.withCurrentReferences(h.tx, h.request, work)).rejects.toMatchObject(
      unavailable,
    );
    expect(work).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(0);
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it.each(["actorReference", "tenantReference"] as const)(
    "refuses foreign %s and preserves a rejecting host guard",
    async (field) => {
      const h = optionSetHarness();
      await expect(h.read({ ...h.request, [field]: id(90) })).rejects.toMatchObject(unavailable);
      expect(h.calls).toHaveLength(0);
      await expect(h.flush()).rejects.toMatchObject(unavailable);
    },
  );
  it("keeps the shortest original lease and rechecks actual current permission before commit", async () => {
    const h = optionSetHarness();
    h.state.deadline = "2026-10-03T12:03:02.000Z";
    expect((await h.read()).validUntil).toBe(h.state.deadline);
    h.state.allowed = false;
    await expect(h.flush()).rejects.toMatchObject(unavailable);
  });
  it("does not renew after registration delay and rejects expiry in the final host phase", async () => {
    const slow = optionSetHarness();
    slow.state.onRegister = async () => {
      slow.state.now = until;
    };
    await expect(slow.read()).rejects.toMatchObject(unavailable);
    expect(slow.holds).toHaveLength(0);
    await expect(slow.flush()).rejects.toMatchObject(unavailable);
    const h = optionSetHarness();
    await h.read();
    const guard = h.guards[0];
    if (!guard) throw Error("fixture guard missing");
    expect(() => guard.final()).toThrow();
    const final = optionSetHarness();
    await final.read();
    for (const g of final.guards) await g.guard();
    final.state.now = until;
    for (const g of final.guards) expect(() => g.final()).toThrow();
  });
  it("captures query identity and poisons swallowed same-host reentry and callback failures", async () => {
    const h = optionSetHarness();
    await h.read();
    h.tx.query = async () => ({ rows: [] });
    await expect(h.flush()).rejects.toMatchObject(unavailable);
    const nested = optionSetHarness();
    let entered = false;
    nested.state.onHold = async () => {
      if (!entered) {
        entered = true;
        await nested.read().catch(() => undefined);
      }
    };
    await expect(nested.read()).rejects.toMatchObject(unavailable);
    await expect(nested.flush()).rejects.toMatchObject(unavailable);
    const failed = optionSetHarness();
    await failed.source
      .withCurrentReferences(failed.tx, failed.request, async () => {
        throw Error("private consumer detail");
      })
      .catch(() => undefined);
    await expect(failed.flush()).rejects.toMatchObject(unavailable);
  });
});
