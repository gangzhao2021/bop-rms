import { describe, expect, it, vi } from "vitest";
import {
  buildSystemMediaImagePromotionAuthorizationDecision,
  systemMediaImagePromotionRequiredFields,
  type SystemMediaImagePromotionAuthorizationDecision,
} from "@bop/permission";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createUploadSession,
  parseUploadSessionReference,
  parseUploadGrantReference,
  parseMediaPurposeCode,
  parseMediaOwnerType,
  parseMediaReferenceId,
  parseMediaVersion,
  parseMediaInstant,
  parseAssetReference,
  parseAssetVersionReference,
  parseObjectEvidenceReference,
  parseMediaChecksum,
} from "../contracts/media.js";
import {
  mediaImageScanAdmissionHash as digest,
  parseMediaImageScanAdmission,
  parseMediaImageScanDelivery,
  type MediaImageScanAdmission,
  type MediaImageScanDelivery,
} from "../contracts/media-image-scan-admission.js";
import { createPostgresMediaImageScanAdmissionStore } from "../infrastructure/persistence/media-image-scan-admission-store.js";
import { resolveMediaImageProcessingSource } from "../infrastructure/persistence/media-image-processing-source.js";
import {
  createMediaImageProcessingTransaction,
  type MediaImageProcessingAuthorityInput,
} from "../infrastructure/persistence/media-image-processing-transaction.js";
import { createMediaImagePromotionPlan } from "../infrastructure/processing/media-image-promotion.js";
import {
  parseS3QuarantineImageConfig,
  parseS3QuarantineImageScanEvent,
} from "../infrastructure/provider/s3-quarantine-image-source.js";
import type { MediaPersistenceTransaction } from "../infrastructure/persistence/media-upload-store.js";

// Only immutable upload-history acquisition is controlled here. The real
// Permission source, Media admission, processing host kernel and Audit append
// run unchanged; native acceptance covers the actual upload-history SQL.
vi.mock("../infrastructure/persistence/media-image-processing-source.js", () => ({
  resolveMediaImageProcessingSource: vi.fn(),
}));
const id = (n: number) => "019a2421-0021-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-02T12:03:00.000Z",
  before = "2026-10-02T12:00:00.000Z",
  until = "2026-10-02T12:03:05.000Z";
const deploymentDigest = "sha256:" + "a".repeat(64);
const unavailable = { code: "MEDIA_IMAGE_SCAN_ADMISSION_UNAVAILABLE" };
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
  const session = createUploadSession({
    uploadSessionId: parseUploadSessionReference(id(4)),
    grantReference: parseUploadGrantReference(id(5)),
    actorReference: id(6),
    purpose: parseMediaPurposeCode("PRODUCT_IMAGE"),
    scope: config.scope,
    mediaKind: "Image",
    declaredContentType: "image/png",
    declaredByteSize: 1234,
    ownerType: parseMediaOwnerType("PRODUCT"),
    ownerReference: parseMediaReferenceId(id(7)),
    classification: "Public",
    state: "Finalized",
    version: parseMediaVersion(2),
    createdAt: parseMediaInstant(before),
    expiresAt: parseMediaInstant("2026-10-02T12:15:00.000Z"),
  });
  const asset = createMediaAsset({
    assetId: parseAssetReference(id(8)),
    purpose: session.purpose,
    scope: config.scope,
    mediaKind: "Image",
    ownerType: session.ownerType,
    ownerReference: session.ownerReference,
    classification: "Public",
    currentVersionReference: null,
    version: parseMediaVersion(1),
  });
  const assetVersion = createMediaAssetVersion({
    assetVersionId: parseAssetVersionReference(id(9)),
    assetId: asset.assetId,
    version: parseMediaVersion(1),
    objectEvidenceReference: parseObjectEvidenceReference(id(10)),
    providerObjectVersion: parseMediaReferenceId(id(11)),
    byteSize: 1234,
    checksum: parseMediaChecksum("sha256:" + "b".repeat(64)),
    contentType: "image/png",
    checkState: "Quarantined",
    readinessState: "Pending",
    createdAt: parseMediaInstant("2026-10-02T12:00:01.000Z"),
  });
  const object = {
    bucket: config.bucket,
    key: config.quarantinePrefix + "c".repeat(64),
    versionId: "opaque/S3+version.1",
    etag: "opaque-etag-2",
    objectEvidenceReference: assetVersion.objectEvidenceReference,
    providerObjectVersion: assetVersion.providerObjectVersion,
  };
  const event = {
    version: "0",
    id: "guardduty-event-1",
    "detail-type": "GuardDuty Malware Protection Object Scan Result",
    source: "aws.guardduty",
    account: config.accountId,
    region: config.region,
    time: "2026-10-02T12:02:00Z",
    resources: [config.protectionPlanArn],
    detail: {
      schemaVersion: "1.0",
      scanStatus: "COMPLETED",
      resourceType: "S3_OBJECT",
      s3ObjectDetails: {
        bucketName: object.bucket,
        objectKey: object.key,
        versionId: object.versionId,
        eTag: object.etag,
        s3Throttled: true,
      },
      scanResultDetails: {
        scanResultStatus: "NO_THREATS_FOUND",
        threats: null,
        statusReasons: null,
      },
    },
  };
  const source = {
    tenantReference: config.tenantReference,
    session,
    asset,
    assetVersion,
    object,
    scanEvent: event,
  };
  const delivery: MediaImageScanDelivery = {
    scanEvent: event,
    transport: {
      profile: "GUARDDUTY_SQS_DELIVERY_V1",
      deploymentConfigurationDigest: deploymentDigest,
      queueArn: "arn:aws:sqs:ca-central-1:111122223333:synthetic-scan",
      queueCreatedAt: before,
      queuePolicyDigest: digest({ syntheticPolicy: true }),
      bodyDigest: digest(event),
      messageId: "message-first",
      sentAt: "2026-10-02T12:02:01.000Z",
      receivedAt: "2026-10-02T12:02:59.000Z",
    },
  };
  return {
    config,
    source,
    event,
    delivery,
    sourceBindingDigest: digest({ syntheticImmutableFinalization: true }),
  };
}
function decision(
  overrides: Partial<Omit<SystemMediaImagePromotionAuthorizationDecision, "digest">> = {},
) {
  return buildSystemMediaImagePromotionAuthorizationDecision({
    profile: "MEDIA_IMAGE_PROMOTION_V1",
    decisionReference: id(20),
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    workloadReference: id(21),
    deploymentConfigurationDigest: deploymentDigest,
    version: 1,
    action: "media.asset.promote",
    purposeCode: "MEDIA_IMAGE_PROMOTION",
    requiredFields: systemMediaImagePromotionRequiredFields,
    enabled: true,
    effectiveFrom: before,
    effectiveUntil: null,
    recordedAt: before,
    auditReference: id(22),
    ...overrides,
  });
}
interface Guard {
  guard: () => Promise<void>;
  final: () => void;
}
interface IntentRow {
  body: unknown;
  digest: string;
  admission_reference: string;
  coherent: boolean;
}
function harness() {
  const f = fixture();
  let now = at;
  const state = {
    decision: decision() as SystemMediaImagePromotionAuthorizationDecision | null,
    admissions: new Map<string, MediaImageScanAdmission>(),
    intents: new Map<string, IntentRow>(),
    audits: [] as (readonly unknown[])[],
    coherent: true,
    committed: 0,
    rollback: 0,
    unknown: false,
    skipGuards: false,
    skipFinal: false,
    afterWork: null as null | (() => Promise<void>),
    afterAsync: null as null | (() => Promise<void>),
    beforeQuery: null as null | ((sql: string, tx: MediaPersistenceTransaction) => Promise<void>),
    onRegister: null as null | (() => Promise<void>),
    activeTx: null as MediaPersistenceTransaction | null,
  };
  const calls: { sql: string; values: readonly unknown[]; tx: MediaPersistenceTransaction }[] = [];
  const hosts = new WeakMap<object, Guard[]>();
  const registerBeforeCommit = async (
    tx: MediaPersistenceTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => {
    const guards = hosts.get(tx);
    if (!guards) throw Error("foreign synthetic transaction");
    guards.push({ guard, final });
    await state.onRegister?.();
  };
  const restore = (snapshot: {
    admissions: Map<string, MediaImageScanAdmission>;
    intents: Map<string, IntentRow>;
    audits: (readonly unknown[])[];
  }) => {
    state.admissions = new Map(snapshot.admissions);
    state.intents = new Map(snapshot.intents);
    state.audits = [...snapshot.audits];
  };
  const snapshot = () => ({
    admissions: new Map(state.admissions),
    intents: new Map(state.intents),
    audits: [...state.audits],
  });
  const transactions = {
    async run<T>(work: (tx: MediaPersistenceTransaction) => Promise<T>): Promise<T> {
      const original = snapshot();
      let saved = original;
      let committed = false;
      const tx: MediaPersistenceTransaction = {
        query: async <Row>(sql: string, values: readonly unknown[]) => {
          calls.push({ sql, values, tx });
          await state.beforeQuery?.(sql, tx);
          let rows: unknown[] = [],
            rowCount = 0;
          if (sql.startsWith("SAVEPOINT")) saved = snapshot();
          else if (sql.startsWith("ROLLBACK TO")) restore(saved);
          else if (
            sql.startsWith("RELEASE SAVEPOINT") ||
            sql.startsWith("SELECT set_config") ||
            sql.startsWith("SELECT pg_advisory")
          ) {
            /* Real control statements, no synthetic rows. */
          } else if (sql.includes("transaction_isolation"))
            rows = [{ isolation: "read committed" }];
          else if (
            sql.includes("FROM bop_permission.system_media_image_promotion_authorization WHERE")
          ) {
            const d = state.decision;
            rows = d
              ? [
                  {
                    workload_id: d.workloadReference,
                    tenant_id: d.tenantReference,
                    brand_id: d.brandReference,
                    store_id: d.storeReference,
                    version: String(d.version),
                    decision_id: d.decisionReference,
                    updated_at: d.recordedAt,
                  },
                ]
              : [];
          } else if (
            sql.includes("FROM bop_permission.system_media_image_promotion_authorization_decision")
          ) {
            const d = state.decision;
            rows = d ? [{ snapshot_json: d, digest: d.digest, coherent: true }] : [];
          } else if (sql.startsWith("INSERT INTO bop_media.image_scan_admission")) {
            const raw = values[21];
            if (typeof raw !== "string") throw Error("invalid controlled record");
            const a = parseMediaImageScanAdmission(JSON.parse(raw));
            state.admissions.set(a.admissionReference, a);
            rowCount = 1;
          } else if (sql.includes("FROM bop_media.image_scan_admission")) {
            const a = sql.includes("WHERE admission_id=")
              ? state.admissions.get(String(values[0]))
              : [...state.admissions.values()].find(
                  (v) =>
                    v.providerAccount === values[0] &&
                    v.region === values[1] &&
                    v.eventId === values[2],
                );
            rows = a ? [{ body: a, digest: a.digest, coherent: state.coherent }] : [];
          } else if (sql.includes("FROM bop_media.image_processing_intent")) {
            const i = state.intents.get(String(values[0]));
            rows = i ? [i] : [];
          } else if (sql.startsWith("INSERT INTO platform_audit.audit_chain_head")) {
            /* Existing chain allocation. */
          } else if (sql.includes("FROM platform_audit.audit_chain_head")) {
            const previous = state.audits.at(-1)?.[23];
            rows = [
              {
                next_sequence: String(state.audits.length + 1),
                previous_hash: Buffer.isBuffer(previous) ? previous.toString("hex") : null,
                recorded_at: now,
              },
            ];
          } else if (sql.startsWith("INSERT INTO platform_audit.audit_record")) {
            state.audits.push(values);
            rowCount = 1;
          } else if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
            rows = [{ next_sequence: String(state.audits.length + 1) }];
          else throw Error("unexpected controlled SQL");
          return { rows: rows as readonly Row[], rowCount };
        },
      };
      const guards: Guard[] = [];
      hosts.set(tx, guards);
      state.activeTx = tx;
      try {
        const result = await work(tx);
        await state.afterWork?.();
        if (!state.skipGuards) for (const g of guards) await g.guard();
        await state.afterAsync?.();
        if (!state.skipFinal) for (const g of guards) g.final();
        committed = true;
        state.committed++;
        if (state.unknown)
          throw Object.assign(Error("controlled lost commit reply"), {
            code: "COMMIT_OUTCOME_UNKNOWN",
          });
        return result;
      } catch (error) {
        if (!committed) {
          restore(original);
          state.rollback++;
        }
        throw error;
      } finally {
        state.activeTx = null;
      }
    },
  };
  const options = {
    tenantReference: id(1),
    scope: f.config.scope,
    workloadReference: id(21),
    deploymentConfigurationDigest: deploymentDigest,
    quarantineConfig: f.config,
    clock: { now: () => now },
    transactions,
    registerBeforeCommit,
  };
  const store = createPostgresMediaImageScanAdmissionStore(options);
  vi.mocked(resolveMediaImageProcessingSource)
    .mockReset()
    .mockImplementation(async (_tx, config, scanEvent) => {
      void _tx;
      parseS3QuarantineImageScanEvent(scanEvent, config, f.source.object);
      return { source: { ...f.source, scanEvent }, sourceBindingDigest: f.sourceBindingDigest };
    });
  return {
    f,
    state,
    calls,
    store,
    options,
    transactions,
    registerBeforeCommit,
    setNow(value: string) {
      now = value;
    },
    getNow: () => now,
  };
}
function requireRecord(h: ReturnType<typeof harness>) {
  const a = [...h.state.admissions.values()][0];
  if (!a) throw Error("controlled admission absent");
  return a;
}
function authorityInput(
  a: MediaImageScanAdmission,
  override: Partial<MediaImageProcessingAuthorityInput> = {},
): MediaImageProcessingAuthorityInput {
  return {
    phase: "Plan",
    sourceAssetVersionReference: a.sourceAssetVersionReference,
    scanEventDigest: a.scanEventDigest,
    admissionReference: a.admissionReference,
    tenantReference: a.tenantReference,
    scope: a.scope,
    systemActorReference: a.workloadReference,
    actorKind: "System",
    action: "media.asset.promote",
    purposeCode: "MEDIA_IMAGE_PROMOTION",
    requiredFields: systemMediaImagePromotionRequiredFields,
    operationReference: null,
    originalIntentDigest: null,
    observedAt: at,
    validUntil: until,
    ...override,
  };
}
function intent(h: ReturnType<typeof harness>, a: MediaImageScanAdmission) {
  const plan = createMediaImagePromotionPlan({
    operationReference: id(30),
    tenantReference: id(1),
    scope: a.scope,
    assetReference: h.f.source.asset.assetId,
    sourceAssetVersionReference: a.sourceAssetVersionReference,
    targetAssetVersionReference: id(31),
    expectedAssetVersion: 1,
    sourceBindingDigest: a.sourceBindingDigest,
    destination: {
      accountId: h.f.config.accountId,
      bucket: "synthetic-clean-images",
      cleanPrefix: "clean/",
      kmsKeyArn: h.f.config.kmsKeyArn,
    },
  });
  const body = {
    profile: "MEDIA_IMAGE_PROCESSING_INTENT_V1",
    operationReference: plan.operationReference,
    tenantReference: id(1),
    scope: a.scope,
    systemActorReference: a.workloadReference,
    sourceBindingDigest: a.sourceBindingDigest,
    source: h.f.source,
    plan,
    createdAt: at,
    auditId: id(32),
    correlationId: a.correlationId,
    admissionReference: a.admissionReference,
  };
  return { body, digest: digest(body), admission_reference: a.admissionReference, coherent: true };
}

describe("private real-permission scan admission with controlled immutable source SQL", () => {
  it("holds actual Permission, appends immutable admission and chained System Audit atomically", async () => {
    const h = harness(),
      result = await h.store.admit(h.f.delivery),
      a = requireRecord(h);
    expect(Object.keys(result).sort()).toEqual([
      "admissionReference",
      "correlationId",
      "scanEvent",
      "sourceAssetVersionReference",
    ]);
    expect(result.admissionReference).toBe(a.admissionReference);
    expect(a.scanEventDigest).toBe(digest(h.f.event));
    expect(a.transport).toEqual(h.f.delivery.transport);
    expect(h.state.audits).toHaveLength(1);
    expect(h.state.audits[0]?.slice(3, 8)).toEqual([
      "System",
      null,
      "MEDIA_IMAGE_SCAN_ADMITTED",
      "MediaAssetVersion",
      h.f.source.assetVersion.assetVersionId,
    ]);
    expect(Buffer.isBuffer(h.state.audits[0]?.[23])).toBe(true);
    expect(h.calls.filter((c) => c.sql.includes("FOR SHARE"))).toHaveLength(2);
    expect(new Set(h.calls.map((c) => c.tx)).size).toBe(1);
    expect(h.state.committed).toBe(1);
    expect(Object.isFrozen(a.scanEvent)).toBe(true);
  });
  it("preserves first provenance across changed SQS redelivery and old message timestamps", async () => {
    const h = harness(),
      first = await h.store.admit(h.f.delivery),
      original = requireRecord(h);
    h.setNow("2026-10-02T13:00:00.000Z");
    const again = await h.store.admit({
      ...h.f.delivery,
      transport: {
        ...h.f.delivery.transport,
        messageId: "redelivery-2",
        bodyDigest: digest("different whitespace"),
        receivedAt: h.getNow(),
      },
    });
    expect(again).toEqual(first);
    expect(requireRecord(h)).toEqual(original);
    expect(h.state.audits).toHaveLength(1);
  });
  it("rejects same event ID with changed clean-event bytes or queue incarnation without replacing provenance", async () => {
    const h = harness();
    await h.store.admit(h.f.delivery);
    const original = requireRecord(h);
    const changed = {
      ...h.f.event,
      detail: {
        ...h.f.event.detail,
        s3ObjectDetails: { ...h.f.event.detail.s3ObjectDetails, s3Throttled: false },
      },
    };
    await expect(h.store.admit({ ...h.f.delivery, scanEvent: changed })).rejects.toMatchObject(
      unavailable,
    );
    await expect(
      h.store.admit({
        ...h.f.delivery,
        transport: { ...h.f.delivery.transport, queueCreatedAt: "2026-10-02T12:00:01.000Z" },
      }),
    ).rejects.toMatchObject(unavailable);
    expect(requireRecord(h)).toEqual(original);
    expect(h.state.audits).toHaveLength(1);
  });
  it.each([
    null,
    decision({ enabled: false }),
    decision({ deploymentConfigurationDigest: digest("foreign config") }),
  ])(
    "refuses missing, disabled or mismatched actual Permission before source lookup",
    async (d) => {
      const h = harness();
      h.state.decision = d;
      await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject(unavailable);
      expect(resolveMediaImageProcessingSource).not.toHaveBeenCalled();
      expect(h.state.admissions.size).toBe(0);
      expect(h.state.audits).toHaveLength(0);
    },
  );
  it("refuses a changed immutable source binding and incoherent recorded index on replay", async () => {
    const h = harness();
    await h.store.admit(h.f.delivery);
    vi.mocked(resolveMediaImageProcessingSource).mockResolvedValue({
      source: h.f.source,
      sourceBindingDigest: digest("another finalized source"),
    });
    await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject(unavailable);
    h.state.coherent = false;
    await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject(unavailable);
    expect(h.state.audits).toHaveLength(1);
  });
  it.each(["Audit", "late permission", "later asynchronous lease"])(
    "rolls back tentative admission and Audit on %s failure",
    async (mode) => {
      const h = harness();
      if (mode === "Audit")
        h.state.beforeQuery = async (sql) => {
          if (sql.startsWith("INSERT INTO platform_audit.audit_record"))
            throw Error("private synthetic failure");
        };
      if (mode === "late permission")
        h.state.afterWork = async () => {
          h.state.decision = decision({ enabled: false });
        };
      if (mode === "later asynchronous lease")
        h.state.afterAsync = async () => {
          h.setNow(until);
        };
      await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject(unavailable);
      expect(h.state.admissions.size).toBe(0);
      expect(h.state.audits).toHaveLength(0);
      expect(h.state.committed).toBe(0);
    },
  );
  it("does not renew the original deadline after a slow guard registration", async () => {
    const h = harness();
    h.state.onRegister = async () => {
      h.setNow(until);
    };
    await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject(unavailable);
    expect(resolveMediaImageProcessingSource).not.toHaveBeenCalled();
    expect(h.state.committed).toBe(0);
  });
  it("recovers the original record after an unknown commit outcome without duplicating Audit", async () => {
    const h = harness();
    h.state.unknown = true;
    await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject({
      code: "MEDIA_IMAGE_SCAN_ADMISSION_OUTCOME_UNKNOWN",
    });
    const a = requireRecord(h);
    h.state.unknown = false;
    expect((await h.store.admit(h.f.delivery)).admissionReference).toBe(a.admissionReference);
    expect(h.state.audits).toHaveLength(1);
  });
  it.each(["all", "final"])("refuses success when the host omits %s guards", async (mode) => {
    const h = harness();
    h.state.skipGuards = mode === "all";
    h.state.skipFinal = true;
    await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject(unavailable);
  });
  it("captures ports and rejects query replacement instead of reading through changed authority", async () => {
    const h = harness();
    h.options.clock.now = () => until;
    const first = await h.store.admit(h.f.delivery);
    expect(first.admissionReference).toBe(requireRecord(h).admissionReference);
    h.state.afterWork = async () => {
      const tx = h.state.activeTx;
      if (!tx) throw Error("missing controlled tx");
      tx.query = async () => ({ rows: [] });
    };
    await expect(h.store.admit(h.f.delivery)).rejects.toMatchObject(unavailable);
  });
});

describe("admission authority bound to the actual processing intent at commit", () => {
  it("allows pre-insert bind but requires the exact persisted intent after the real processing kernel's final authority", async () => {
    const h = harness();
    await h.store.admit(h.f.delivery);
    const a = requireRecord(h),
      i = intent(h, a);
    const kernel = createMediaImageProcessingTransaction({
      tenantReference: id(1),
      scope: a.scope,
      systemActorReference: a.workloadReference,
      clock: { now: h.getNow },
      transactions: h.transactions,
      registerBeforeCommit: h.registerBeforeCommit,
      authority: h.store.authority,
    });
    const result = await kernel.run(
      {
        phase: "Plan",
        sourceAssetVersionReference: a.sourceAssetVersionReference,
        scanEventDigest: a.scanEventDigest,
        admissionReference: a.admissionReference,
      },
      async (ctx) => {
        await ctx.bind(i.body.operationReference, i.digest);
        expect(h.state.intents.size).toBe(0);
        h.state.intents.set(i.body.operationReference, i);
        return "planned";
      },
    );
    expect(result).toBe("planned");
    expect(h.state.committed).toBe(2);
  });
  it.each(["absent", "wrong digest", "wrong admission", "changed source"])(
    "refuses %s intent in the final guard",
    async (mode) => {
      const h = harness();
      await h.store.admit(h.f.delivery);
      const a = requireRecord(h),
        i = intent(h, a);
      await expect(
        h.transactions.run(async (tx) => {
          await h.store.authority.holdUntilTransactionCompletes(tx, authorityInput(a));
          await h.store.authority.holdUntilTransactionCompletes(
            tx,
            authorityInput(a, {
              operationReference: i.body.operationReference,
              originalIntentDigest: i.digest,
            }),
          );
          if (mode !== "absent")
            h.state.intents.set(
              i.body.operationReference,
              mode === "wrong digest"
                ? { ...i, digest: digest("wrong") }
                : mode === "wrong admission"
                  ? { ...i, admission_reference: id(90) }
                  : { ...i, body: { ...i.body, sourceBindingDigest: digest("changed") } },
            );
        }),
      ).rejects.toMatchObject(unavailable);
      expect(h.state.intents.size).toBe(0);
    },
  );
  it("cannot commit a swallowed early input failure or a caught reentry", async () => {
    const h = harness();
    await h.store.admit(h.f.delivery);
    const a = requireRecord(h);
    await expect(
      h.transactions.run(async (tx) => {
        await h.store.authority
          .holdUntilTransactionCompletes(tx, authorityInput(a, { tenantReference: id(99) }))
          .catch(() => undefined);
      }),
    ).rejects.toMatchObject(unavailable);
    let tried = false;
    h.state.beforeQuery = async (sql, tx) => {
      if (
        !tried &&
        sql.includes("FROM bop_permission.system_media_image_promotion_authorization WHERE")
      ) {
        tried = true;
        await h.store.authority
          .holdUntilTransactionCompletes(tx, authorityInput(a))
          .catch(() => undefined);
      }
    };
    await expect(
      h.transactions.run(async (tx) => {
        await h.store.authority
          .holdUntilTransactionCompletes(tx, authorityInput(a))
          .catch(() => undefined);
      }),
    ).rejects.toMatchObject(unavailable);
  });
  it("does not accept a different source, event digest or workload after an earlier successful hold", async () => {
    const h = harness();
    await h.store.admit(h.f.delivery);
    const a = requireRecord(h);
    for (const change of [
      { sourceAssetVersionReference: id(91) },
      { scanEventDigest: digest("other event") },
      { systemActorReference: id(92) },
    ]) {
      await expect(
        h.transactions.run(async (tx) => {
          await h.store.authority.holdUntilTransactionCompletes(tx, authorityInput(a));
          await h.store.authority
            .holdUntilTransactionCompletes(tx, authorityInput(a, change))
            .catch(() => undefined);
        }),
      ).rejects.toMatchObject(unavailable);
    }
  });
});

describe("closed admission provenance", () => {
  it("bounds invalid factory configuration errors and never evaluates a configuration getter", () => {
    const h = harness(),
      getter = vi.fn(() => h.f.config),
      value = { ...h.options };
    Object.defineProperty(value, "quarantineConfig", { enumerable: true, get: getter });
    expect(() => createPostgresMediaImageScanAdmissionStore(value)).toThrow(
      expect.objectContaining(unavailable),
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects untrusted accessors without invoking them and refuses non-clean/extra envelopes", () => {
    const f = fixture(),
      getter = vi.fn(() => f.event),
      input = { ...f.delivery };
    Object.defineProperty(input, "scanEvent", { enumerable: true, get: getter });
    expect(() => parseMediaImageScanDelivery(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => parseMediaImageScanDelivery({ ...f.delivery, authenticated: true })).toThrow();
    expect(() =>
      parseMediaImageScanDelivery({
        ...f.delivery,
        scanEvent: { ...f.event, detail: { ...f.event.detail, scanStatus: "FAILED" } },
      }),
    ).toThrow();
  });
  it("detects record, transport or digest mutation without trusting a clean-event literal", async () => {
    const h = harness();
    await h.store.admit(h.f.delivery);
    const a = requireRecord(h);
    expect(parseMediaImageScanAdmission(a)).toEqual(a);
    for (const v of [
      { ...a, sourceBindingDigest: digest("other") },
      { ...a, transport: { ...a.transport, messageId: "transplant" } },
      { ...a, digest: digest("other") },
    ])
      expect(() => parseMediaImageScanAdmission(v)).toThrow();
    expect(Buffer.byteLength(JSON.stringify(a), "utf8")).toBeLessThan(65536);
  });
});
