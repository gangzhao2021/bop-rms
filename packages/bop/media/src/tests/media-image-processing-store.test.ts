import { afterEach, expect, it, vi } from "vitest";
import {
  appendAuditRecordInTransaction,
  auditChainContent,
  canonicalizeRfc8785,
  computeAuditRecordHash,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  createUploadSession,
  type MediaAsset,
  type MediaAssetVersion,
} from "../contracts/media.js";
import {
  mediaImagePromotionPlanDigest,
  parseMediaImagePromotionResult,
  type MediaImagePromotionResult,
  type MediaPromotedRendition,
} from "../infrastructure/processing/media-image-promotion.js";
import {
  createMediaImageProcessingStore,
  type MediaImageProcessingIntent,
  type MediaImageProcessingStoreOptions,
} from "../infrastructure/persistence/media-image-processing-store.js";
import { loadMediaImageProcessingSource } from "../infrastructure/persistence/media-image-processing-source.js";
import type { MediaImageProcessingAuthorityInput } from "../infrastructure/persistence/media-image-processing-transaction.js";
import type { MediaPersistenceTransaction } from "../infrastructure/persistence/media-upload-store.js";
import type { S3QuarantineImageConfig } from "../infrastructure/provider/s3-quarantine-image-source.js";

vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));
vi.mock("../infrastructure/persistence/media-image-processing-source.js", () => ({
  loadMediaImageProcessingSource: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

const id = (n: number) => "019a2421-0023-7000-8000-" + n.toString(16).padStart(12, "0"),
  checksum = (n: number) => "sha256:" + n.toString(16).padStart(64, "0"),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  at = "2026-10-03T12:01:01.000Z",
  unavailable = expect.objectContaining({ code: "MEDIA_COMMIT_FAILED" });

function fixture() {
  const scope = createMediaScope({
    kind: "Store",
    brandReference: id(2),
    storeReference: id(3),
  } as Parameters<typeof createMediaScope>[0]);
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
    assetId: asset.assetId,
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
  const config: S3QuarantineImageConfig = {
    tenantReference: id(1),
    scope,
    region: "ca-central-1",
    accountId: "111122223333",
    bucket: "synthetic-quarantine-images",
    quarantinePrefix: "quarantine/",
    kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    protectionPlanArn:
      "arn:aws:guardduty:ca-central-1:111122223333:malware-protection-plan/synthetic123",
  };
  const object = {
    bucket: config.bucket,
    key: "quarantine/" + "a".repeat(64),
    versionId: "opaque/actual+S3.version",
    etag: "opaque-etag-2",
    objectEvidenceReference: assetVersion.objectEvidenceReference,
    providerObjectVersion: assetVersion.providerObjectVersion,
  };
  const scanEvent = {
    version: "0",
    id: "guardduty-event-1",
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
        s3Throttled: true,
      },
      scanResultDetails: {
        scanResultStatus: "NO_THREATS_FOUND",
        threats: null,
        statusReasons: null,
      },
    },
  };
  const source = Object.freeze({
    tenantReference: config.tenantReference,
    session,
    asset,
    assetVersion,
    object,
    scanEvent,
  });
  const request = {
    sourceAssetVersionReference: assetVersion.assetVersionId,
    scanEvent,
    admissionReference: id(20),
    correlationId: id(21),
  };
  return { source, config, request };
}

interface IntentRow {
  body: MediaImageProcessingIntent;
  digest: string;
  plan_digest: string;
  coherent: boolean;
}
interface CompletionRow {
  result: MediaImagePromotionResult;
  digest: string;
  asset: MediaAsset;
  version: MediaAssetVersion;
  recorded_at: string;
  coherent: boolean;
}
interface Tables {
  asset: MediaAsset;
  intents: Map<string, IntentRow>;
  completions: Map<string, CompletionRow>;
  versions: Map<string, MediaAssetVersion>;
  renditions: Map<string, MediaPromotedRendition[]>;
  audits: AppendAuditRecordInput[];
  auditHead: string | null;
}
function decoded<T>(value: unknown): T {
  if (typeof value !== "string") throw Error("Expected synthetic SQL JSON parameter");
  return JSON.parse(value) as T;
}

// Synthetic trusted admission, immutable source and SQL rows only. The real
// short transaction kernel and owning parsers run here; native SQL, IAM and
// actual scanner/Sharp/S3 evidence are covered by their separate acceptance.
function harness() {
  const f = fixture(),
    holders: MediaImageProcessingAuthorityInput[] = [],
    statements: string[] = [];
  const state: {
    clock: string;
    tables: Tables;
    commits: number;
    casZero: boolean;
    auditFail: boolean;
    auditFailures: number;
    authorityFailures: number;
    deny: boolean;
    afterWork?: () => void;
    afterAsync?: () => void;
    actualTx?: MediaPersistenceTransaction;
  } = {
    clock: at,
    commits: 0,
    casZero: false,
    auditFail: false,
    auditFailures: 0,
    authorityFailures: 0,
    deny: false,
    tables: {
      asset: f.source.asset,
      intents: new Map(),
      completions: new Map(),
      versions: new Map([[f.source.assetVersion.assetVersionId, f.source.assetVersion]]),
      renditions: new Map(),
      audits: [],
      auditHead: null,
    },
  };
  let guards: { asyncGuard: () => Promise<void>; finalAssert: () => void }[] = [];
  const options: MediaImageProcessingStoreOptions = {
    tenantReference: f.config.tenantReference,
    scope: f.config.scope,
    systemActorReference: id(22),
    quarantineConfig: f.config,
    destination: {
      accountId: f.config.accountId,
      bucket: "synthetic-clean-images",
      cleanPrefix: "clean/images/",
      kmsKeyArn: f.config.kmsKeyArn,
    },
    clock: { now: () => state.clock },
    async registerBeforeCommit(tx, asyncGuard, finalAssert) {
      expect(tx).toBe(state.actualTx);
      guards.push({ asyncGuard, finalAssert });
    },
    authority: {
      async holdUntilTransactionCompletes(tx, request) {
        expect(tx).toBe(state.actualTx);
        holders.push(request);
        if (state.deny) {
          state.authorityFailures++;
          throw Error("Synthetic System or scan admission withdrawn");
        }
        return { observedAt: request.observedAt, validUntil: request.validUntil };
      },
    },
    transactions: {
      async run<T>(work: (tx: MediaPersistenceTransaction) => Promise<T>): Promise<T> {
        const before = structuredClone(state.tables);
        let savepoint: Tables | undefined;
        guards = [];
        const tx: MediaPersistenceTransaction = {
          async query<Row>(sql: string, values: readonly unknown[]) {
            statements.push(sql);
            let rows: unknown[] = [],
              rowCount = 1;
            if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
            else if (sql.startsWith("SAVEPOINT")) savepoint = structuredClone(state.tables);
            else if (sql.startsWith("ROLLBACK TO")) {
              if (!savepoint) throw Error("Missing synthetic savepoint");
              state.tables = structuredClone(savepoint);
            } else if (
              sql.startsWith("RELEASE") ||
              sql.includes("set_config") ||
              sql.includes("pg_advisory_xact_lock")
            ) {
              // The real kernel sets scope and serializes the owning source/event.
            } else if (sql.startsWith("SELECT intent_json")) {
              const found = sql.includes("WHERE operation_id")
                ? state.tables.intents.get(String(values[4]))
                : [...state.tables.intents.values()].find(
                    (r) =>
                      r.body.plan.sourceAssetVersionReference === values[4] &&
                      (r.body.source.scanEvent as { id: string }).id === values[5],
                  );
              if (found) rows = [found];
            } else if (sql.includes("FROM bop_media.image_processing_completion")) {
              const found = state.tables.completions.get(String(values[4]));
              if (found) rows = [found];
            } else if (sql.includes("FROM bop_media.asset_version")) {
              const snapshot = state.tables.versions.get(String(values[3]));
              if (snapshot) rows = [{ snapshot, coherent: true }];
            } else if (sql.includes("FROM bop_media.image_rendition")) {
              rows = (state.tables.renditions.get(String(values[3])) ?? []).map((snapshot) => ({
                snapshot,
                coherent: true,
              }));
            } else if (sql.includes("FROM bop_media.asset WHERE"))
              rows = [{ snapshot: state.tables.asset, coherent: true }];
            else if (sql.startsWith("INSERT INTO bop_media.image_processing_intent")) {
              state.tables.intents.set(String(values[0]), {
                body: decoded(values[13]),
                digest: String(values[12]),
                plan_digest: String(values[11]),
                coherent: true,
              });
            } else if (sql.startsWith("INSERT INTO bop_media.asset_version")) {
              state.tables.versions.set(String(values[0]), decoded(values[8]));
            } else if (sql.startsWith("INSERT INTO bop_media.image_rendition")) {
              const key = String(values[0]),
                list = state.tables.renditions.get(key) ?? [];
              list.push(decoded(values[11]));
              state.tables.renditions.set(key, list);
            } else if (sql.startsWith("INSERT INTO bop_media.image_processing_completion")) {
              state.tables.completions.set(String(values[0]), {
                result: decoded(values[10]),
                digest: String(values[9]),
                asset: decoded(values[11]),
                version: decoded(values[12]),
                recorded_at: String(values[8]),
                coherent: true,
              });
            } else if (sql.startsWith("UPDATE bop_media.asset SET")) {
              if (state.casZero || state.tables.asset.version !== values[4]) rowCount = 0;
              else state.tables.asset = decoded(values[7]);
            } else throw Error("Unexpected synthetic query: " + sql);
            return { rows: structuredClone(rows) as readonly Row[], rowCount };
          },
        };
        state.actualTx = tx;
        try {
          const value = await work(tx);
          state.afterWork?.();
          for (const guard of guards) await guard.asyncGuard();
          state.afterAsync?.();
          for (const guard of guards) guard.finalAssert();
          state.commits++;
          return value;
        } catch (error) {
          state.tables = before;
          throw error;
        }
      },
    },
  };
  vi.mocked(loadMediaImageProcessingSource).mockImplementation(
    async (tx, config, sourceVersion, event) => {
      expect(tx).not.toBe(state.actualTx);
      expect(Object.isFrozen(tx)).toBe(true);
      expect(config).toEqual(f.config);
      expect(sourceVersion).toBe(f.source.assetVersion.assetVersionId);
      expect(event).toEqual(f.source.scanEvent);
      return { source: f.source, sourceBindingDigest: checksum(1) };
    },
  );
  vi.mocked(appendAuditRecordInTransaction).mockImplementation(async (tx, input) => {
    expect(tx).not.toBe(state.actualTx);
    state.tables.audits.push(input);
    if (state.auditFail) {
      state.auditFailures++;
      throw Error("Synthetic Audit failure");
    }
    const content = auditChainContent(input),
      sequence = state.tables.audits.length,
      previousHash = state.tables.auditHead,
      recordedAt = state.clock,
      recordHash = computeAuditRecordHash({ content, sequence, previousHash, recordedAt });
    state.tables.auditHead = recordHash;
    return {
      version: "AUDIT_CHAIN_V1",
      content,
      sequence,
      previousHash,
      recordedAt,
      recordHash,
    };
  });
  return {
    ...f,
    state,
    options,
    holders,
    statements,
    store: createMediaImageProcessingStore(options),
  };
}

function resultFor(h: ReturnType<typeof harness>, intent: MediaImageProcessingIntent) {
  const plan = intent.plan,
    source = h.source;
  return parseMediaImagePromotionResult(
    {
      profile: "PUBLIC_IMAGE_RESULT_V1",
      operationReference: plan.operationReference,
      planDigest: mediaImagePromotionPlanDigest(plan),
      sourceEvidence: {
        ...source.object,
        tenantReference: source.tenantReference,
        scope: source.asset.scope,
        uploadSessionReference: source.session.uploadSessionId,
        assetReference: source.asset.assetId,
        assetVersionReference: source.assetVersion.assetVersionId,
        byteSize: source.assetVersion.byteSize,
        checksum: source.assetVersion.checksum,
        kmsKeyArn: h.config.kmsKeyArn,
      },
      scanEvidence: {
        eventId: source.scanEvent.id,
        eventTime: source.scanEvent.time,
        accountId: h.config.accountId,
        region: h.config.region,
        protectionPlanArn: h.config.protectionPlanArn,
        result: "NO_THREATS_FOUND",
        s3Throttled: true,
      },
      original: {
        ...plan.original,
        bucket: plan.destination.bucket,
        versionId: "synthetic-original-version",
        etag: "original-etag",
        contentType: source.assetVersion.contentType,
        byteSize: source.assetVersion.byteSize,
        checksum: source.assetVersion.checksum,
      },
      renditions: plan.renditions.map((r, n) => ({
        ...r,
        bucket: plan.destination.bucket,
        versionId: "synthetic-version-" + n,
        etag: "synthetic-etag-" + n,
        height: (r.width * 3) / 4,
        byteSize: 2000 + n,
        checksum: checksum(100 + n),
      })),
      completedAt: h.state.clock,
    },
    plan,
    source,
  );
}
const mutations = (h: ReturnType<typeof harness>) =>
  h.statements.filter((sql) => sql.startsWith("INSERT") || sql.startsWith("UPDATE"));

it("persists one same-event plan and recovers its original keys, IDs and Audit without reallocating", async () => {
  const h = harness(),
    first = await h.store.plan(h.request),
    before = structuredClone(h.state.tables);
  h.state.clock = "2026-10-03T12:01:02.000Z";
  const second = await h.store.plan(h.request);
  expect(second).toEqual(first);
  expect(second.completion).toBeNull();
  expect(h.state.tables).toEqual(before);
  expect(mutations(h)).toHaveLength(1);
  expect(h.state.tables.intents.size).toBe(1);
  expect(
    new Set([first.intent.plan.original, ...first.intent.plan.renditions].map((r) => r.key)).size,
  ).toBe(7);
  expect(h.state.tables.audits).toEqual([
    expect.objectContaining({
      actor: { type: "System" },
      actionCode: "MEDIA_IMAGE_PROCESSING_PLANNED",
      targetId: h.source.asset.assetId,
    }),
  ]);
  expect(
    h.holders.every(
      (r) =>
        r.actorKind === "System" &&
        r.admissionReference === h.request.admissionReference &&
        r.scanEventDigest === hash(h.request.scanEvent),
    ),
  ).toBe(true);
  expect(
    h.holders
      .filter((r) => r.operationReference !== null)
      .every(
        (r) =>
          r.operationReference === first.intent.operationReference &&
          r.originalIntentDigest === hash(first.intent),
      ),
  ).toBe(true);
});

it("writes a new Clean Ready representative with six companions and recovers the original receipt after a later root", async () => {
  const h = harness(),
    { intent } = await h.store.plan(h.request);
  h.state.clock = "2026-10-03T12:01:02.000Z";
  const result = resultFor(h, intent),
    receipt = await h.store.complete({ intent, result });
  const representative = result.renditions.find(
    (r) => r.width === 1280 && r.contentType === "image/jpeg",
  );
  if (!representative) throw Error("Missing fixture representative");
  expect(receipt.asset).toMatchObject({
    version: 2,
    currentVersionReference: intent.plan.targetAssetVersionReference,
  });
  expect(receipt.assetVersion).toMatchObject({
    version: 2,
    checkState: "Clean",
    readinessState: "Ready",
    contentType: "image/jpeg",
    objectEvidenceReference: representative.objectEvidenceReference,
    providerObjectVersion: representative.providerObjectVersion,
    createdAt: h.state.clock,
  });
  expect(receipt.assetVersion.objectEvidenceReference).not.toBe(
    result.original.objectEvidenceReference,
  );
  expect(h.state.tables.versions.get(h.source.assetVersion.assetVersionId)).toEqual(
    h.source.assetVersion,
  );
  expect(h.state.tables.renditions.get(intent.plan.targetAssetVersionReference)).toEqual(
    result.renditions,
  );
  expect(h.state.tables.audits.map((r) => r.actionCode)).toEqual([
    "MEDIA_IMAGE_PROCESSING_PLANNED",
    "MEDIA_IMAGE_PROCESSING_COMPLETED",
  ]);
  h.state.tables.asset = createMediaAsset({ ...receipt.asset, version: 3 } as MediaAsset);
  const before = structuredClone(h.state.tables),
    writeCount = mutations(h).length;
  h.state.clock = "2026-10-03T12:02:00.000Z";
  expect(await h.store.complete({ intent, result })).toEqual(receipt);
  expect((await h.store.plan(h.request)).completion).toEqual(receipt);
  expect(h.state.tables).toEqual(before);
  expect(mutations(h)).toHaveLength(writeCount);
  expect(h.statements.filter((q) => q.includes("FROM bop_media.asset_version"))).toHaveLength(2);
  expect(h.statements.filter((q) => q.includes("FROM bop_media.image_rendition"))).toHaveLength(2);
});

it.each([
  "missing-version",
  "altered-version",
  "missing-rendition",
  "altered-rendition",
  "stored-digest",
])("refuses %s in a recorded completion instead of trusting only its receipt", async (fault) => {
  const h = harness(),
    { intent } = await h.store.plan(h.request),
    result = resultFor(h, intent);
  await h.store.complete({ intent, result });
  const target = intent.plan.targetAssetVersionReference;
  if (fault === "missing-version") h.state.tables.versions.delete(target);
  if (fault === "altered-version") h.state.tables.versions.set(target, h.source.assetVersion);
  if (fault === "missing-rendition") h.state.tables.renditions.get(target)?.pop();
  if (fault === "altered-rendition") {
    const list = h.state.tables.renditions.get(target);
    if (!list?.[0]) throw Error("Missing fixture rendition");
    list[0] = { ...list[0], checksum: checksum(999) };
  }
  if (fault === "stored-digest") {
    const row = h.state.tables.completions.get(intent.operationReference);
    if (!row) throw Error("Missing fixture completion");
    row.digest = checksum(999);
  }
  const before = structuredClone(h.state.tables),
    writes = mutations(h).length;
  await expect(h.store.complete({ intent, result })).rejects.toThrow(unavailable);
  expect(h.state.tables).toEqual(before);
  expect(mutations(h)).toHaveLength(writes);
});

it.each([
  "stale-root",
  "foreign-root",
  "source-changed",
  "wrong-result-source",
  "wrong-result-plan",
  "wrong-source-kms",
])("rejects %s before completing any version or rendition", async (fault) => {
  const h = harness(),
    { intent } = await h.store.plan(h.request),
    result = structuredClone(resultFor(h, intent));
  if (fault === "stale-root")
    h.state.tables.asset = createMediaAsset({ ...h.source.asset, version: 2 } as MediaAsset);
  if (fault === "foreign-root")
    h.state.tables.asset = createMediaAsset({
      ...h.source.asset,
      scope: createMediaScope({
        kind: "Store",
        brandReference: id(2),
        storeReference: id(88),
      } as Parameters<typeof createMediaScope>[0]),
    });
  if (fault === "source-changed")
    vi.mocked(loadMediaImageProcessingSource).mockResolvedValue({
      source: h.source,
      sourceBindingDigest: checksum(999),
    });
  if (fault === "wrong-result-source")
    Object.assign(result.sourceEvidence, { versionId: "another-source-version" });
  if (fault === "wrong-result-plan") Object.assign(result, { planDigest: checksum(999) });
  if (fault === "wrong-source-kms")
    Object.assign(result.sourceEvidence, {
      kmsKeyArn: "arn:aws:kms:ca-central-1:111122223333:key/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
  const before = structuredClone(h.state.tables),
    writes = mutations(h).length;
  await expect(h.store.complete({ intent, result })).rejects.toThrow(unavailable);
  expect(h.state.tables).toEqual(before);
  expect(mutations(h)).toHaveLength(writes);
});

it("rejects a plan against an actual root in a different Store without recording an intent", async () => {
  const h = harness();
  h.state.tables.asset = createMediaAsset({
    ...h.source.asset,
    scope: createMediaScope({
      kind: "Store",
      brandReference: id(2),
      storeReference: id(99),
    } as Parameters<typeof createMediaScope>[0]),
  });
  await expect(h.store.plan(h.request)).rejects.toThrow(unavailable);
  expect(h.state.tables.intents.size).toBe(0);
  expect(h.state.tables.audits).toHaveLength(0);
  expect(mutations(h)).toHaveLength(0);
});

it.each(["cas-zero", "audit", "late-authority", "final-deadline"])(
  "rolls back the tentative complete version, six renditions, receipt, root and Audit on %s",
  async (fault) => {
    const h = harness(),
      { intent } = await h.store.plan(h.request),
      result = resultFor(h, intent),
      before = structuredClone(h.state.tables);
    const observed: { tables?: Tables } = {};
    if (fault === "cas-zero") h.state.casZero = true;
    if (fault === "audit") h.state.auditFail = true;
    const observe = () => {
      observed.tables = structuredClone(h.state.tables);
    };
    if (fault === "late-authority")
      h.state.afterWork = () => {
        observe();
        h.state.deny = true;
      };
    if (fault === "final-deadline")
      h.state.afterAsync = () => {
        observe();
        h.state.clock = "2026-10-03T12:01:06.000Z";
      };
    await expect(h.store.complete({ intent, result })).rejects.toThrow(unavailable);
    expect(h.state.tables).toEqual(before);
    expect(h.state.commits).toBe(1);
    expect(
      h.statements.filter((q) => q.startsWith("INSERT INTO bop_media.image_rendition")),
    ).toHaveLength(6);
    if (fault === "late-authority" || fault === "final-deadline") {
      expect(observed.tables?.completions.size).toBe(1);
      expect(observed.tables?.versions.size).toBe(2);
      expect(observed.tables?.renditions.get(intent.plan.targetAssetVersionReference)).toHaveLength(
        6,
      );
      expect(observed.tables?.asset.version).toBe(2);
      expect(observed.tables?.audits).toHaveLength(2);
    } else expect(h.statements).toContain("ROLLBACK TO SAVEPOINT media_image_processing");
    if (fault === "audit") expect(h.state.auditFailures).toBe(1);
    if (fault === "late-authority") expect(h.state.authorityFailures).toBe(1);
  },
);

it("rolls back plan and its Audit together when current System admission is withdrawn after work", async () => {
  const h = harness(),
    before = structuredClone(h.state.tables),
    observed: { tables?: Tables } = {};
  h.state.afterWork = () => {
    observed.tables = structuredClone(h.state.tables);
    h.state.deny = true;
  };
  await expect(h.store.plan(h.request)).rejects.toThrow(unavailable);
  expect(observed.tables?.intents.size).toBe(1);
  expect(observed.tables?.audits).toHaveLength(1);
  expect(h.state.authorityFailures).toBe(1);
  expect(h.state.tables).toEqual(before);
  expect(h.state.commits).toBe(0);
});
