import { v7 as uuidV7 } from "uuid";
import { appendAuditRecordInTransaction, canonicalizeRfc8785 } from "@bop/audit";
import {
  createPostgresSystemMediaImagePromotionAuthorizationSource,
  systemMediaImagePromotionRequiredFields,
} from "@bop/permission";
import {
  createMediaScope,
  parseAssetVersionReference,
  parseMediaInstant,
  parseMediaReferenceId,
  type MediaScope,
} from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import {
  buildMediaImageScanAdmission,
  mediaImageScanAdmissionHash,
  parseMediaImageScanAdmission,
  parseMediaImageScanDelivery,
  MediaImageScanAdmissionError,
  type MediaImageScanAdmission,
  type MediaImageScanDelivery,
} from "../../contracts/media-image-scan-admission.js";
import {
  parseS3QuarantineImageConfig,
  parseS3QuarantineImageScanEvent,
  type S3QuarantineImageConfig,
} from "../provider/s3-quarantine-image-source.js";
import { resolveMediaImageProcessingSource } from "./media-image-processing-source.js";
import type { MediaImageProcessingAuthorityInput } from "./media-image-processing-transaction.js";
import type { MediaPersistenceTransaction } from "./media-upload-store.js";

export interface MediaImageScanAdmissionStoreOptions {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly workloadReference: string;
  readonly deploymentConfigurationDigest: string;
  readonly quarantineConfig: S3QuarantineImageConfig;
  readonly clock: { now(): string };
  readonly transactions: {
    run<T>(work: (tx: MediaPersistenceTransaction) => Promise<T>): Promise<T>;
  };
  readonly registerBeforeCommit: (
    tx: MediaPersistenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
const fail = (): never => {
  throw new MediaImageScanAdmissionError();
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const hash = (v: unknown): string =>
  typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v) ? v : fail();
function closed(v: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[key] = d.value;
  }
  return r;
}
function one(v: unknown): Record<string, unknown> | null {
  const d = v && typeof v === "object" ? Object.getOwnPropertyDescriptor(v, "rows") : undefined;
  if (!d || !("value" in d)) return fail();
  const rows = copyMediaUploadStorageValue(d.value);
  if (!Array.isArray(rows) || rows.length > 1) return fail();
  if (!rows.length) return null;
  if (!rows[0] || typeof rows[0] !== "object" || Array.isArray(rows[0])) return fail();
  return rows[0] as Record<string, unknown>;
}
const admissionSql = `SELECT snapshot_json body,digest,
 (admission_id::text=snapshot_json->>'admissionReference' AND tenant_id::text=snapshot_json->>'tenantReference'
 AND brand_id::text=snapshot_json#>>'{scope,brandReference}' AND store_id::text IS NOT DISTINCT FROM snapshot_json#>>'{scope,storeReference}'
 AND workload_id::text=snapshot_json->>'workloadReference' AND deployment_config_digest=snapshot_json->>'deploymentConfigurationDigest'
 AND quarantine_config_digest=snapshot_json->>'quarantineConfigurationDigest' AND provider_account=snapshot_json->>'providerAccount'
 AND region=snapshot_json->>'region' AND protection_plan_arn=snapshot_json->>'protectionPlanArn' AND event_id=snapshot_json->>'eventId'
 AND event_digest=snapshot_json->>'scanEventDigest' AND source_asset_version_id::text=snapshot_json->>'sourceAssetVersionReference'
 AND source_binding_digest=snapshot_json->>'sourceBindingDigest' AND bucket=snapshot_json#>>'{object,bucket}'
 AND key=snapshot_json#>>'{object,key}' AND version_id=snapshot_json#>>'{object,versionId}' AND etag=snapshot_json#>>'{object,etag}'
 AND admitted_at=(snapshot_json->>'admittedAt')::timestamptz AND audit_id::text=snapshot_json->>'auditReference'
 AND correlation_id::text=snapshot_json->>'correlationId' AND digest=snapshot_json->>'digest') IS TRUE coherent
 FROM bop_media.image_scan_admission`;

/** Private owning admission. Only the server SDK ingress invokes admit; no
 * public endpoint accepts delivery JSON. Transport parsing is not an Allow
 * port: current System permission always comes from its real owning source. */
export function createPostgresMediaImageScanAdmissionStore(
  options: MediaImageScanAdmissionStoreOptions,
) {
  try {
    const r = closed(options, [
        "tenantReference",
        "scope",
        "workloadReference",
        "deploymentConfigurationDigest",
        "quarantineConfig",
        "clock",
        "transactions",
        "registerBeforeCommit",
      ]),
      tenantReference = parseMediaReferenceId(r.tenantReference),
      scope = createMediaScope(copyMediaUploadStorageValue(r.scope) as MediaScope),
      workloadReference = parseMediaReferenceId(r.workloadReference),
      configurationDigest = hash(r.deploymentConfigurationDigest),
      config = parseS3QuarantineImageConfig(r.quarantineConfig),
      quarantineDigest = mediaImageScanAdmissionHash(config),
      clock = closed(r.clock, ["now"]),
      transactions = closed(r.transactions, ["run"]);
    if (
      tenantReference !== config.tenantReference ||
      !equal(scope, config.scope) ||
      typeof clock.now !== "function" ||
      typeof transactions.run !== "function" ||
      typeof r.registerBeforeCommit !== "function"
    )
      return fail();
    const now = (clock.now as () => string).bind(r.clock),
      run = (transactions.run as MediaImageScanAdmissionStoreOptions["transactions"]["run"]).bind(
        r.transactions,
      ),
      register = (
        r.registerBeforeCommit as MediaImageScanAdmissionStoreOptions["registerBeforeCommit"]
      ).bind(options),
      actualTransactions = new WeakMap<object, MediaPersistenceTransaction>();
    const permission = createPostgresSystemMediaImagePromotionAuthorizationSource({
      tenantReference,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      workloadReference,
      deploymentConfigurationDigest: configurationDigest,
      clock: { now },
      registerBeforeCommit: async (tx, guard, finalAssert) => {
        const actual = actualTransactions.get(tx);
        if (!actual) return fail();
        await register(actual, guard, finalAssert);
      },
    });
    interface State {
      tx: MediaPersistenceTransaction;
      query: MediaPersistenceTransaction["query"];
      raw: MediaPersistenceTransaction["query"];
      originalQuery: MediaPersistenceTransaction["query"];
      observedAt: string;
      deadline: string;
      latest: string;
      busy: boolean;
      ready: boolean;
      failed: boolean;
      pending: number;
      asyncCalls: number;
      asyncComplete: boolean;
      finalCalls: number;
      finalComplete: boolean;
      onCommit: (() => Promise<void>) | null;
      binding: MediaImageProcessingAuthorityInput | null;
      mode: "Admit" | "Hold";
    }
    const states = new WeakMap<object, State>();
    const poison = (s: State): never => {
      s.failed = true;
      return fail();
    };
    const check = (s: State) => {
      try {
        const d = Object.getOwnPropertyDescriptor(s.tx, "query"),
          at = parseMediaInstant(now());
        if (
          s.failed ||
          !d ||
          !("value" in d) ||
          d.value !== s.originalQuery ||
          !s.deadline ||
          at < s.latest ||
          at >= s.deadline
        )
          return poison(s);
        s.latest = at;
        return at;
      } catch {
        return poison(s);
      }
    };
    async function open(
      tx: MediaPersistenceTransaction,
      observedAt: string | undefined,
      validUntil: string | undefined,
      mode: State["mode"],
    ): Promise<State> {
      if (!tx || typeof tx !== "object") return fail();
      let s = states.get(tx);
      if (s) {
        if (
          s.failed ||
          s.busy ||
          s.mode !== mode ||
          s.asyncCalls ||
          s.finalCalls ||
          observedAt !== s.observedAt ||
          !validUntil ||
          validUntil > s.deadline
        )
          return poison(s);
        s.deadline = validUntil;
        s.busy = true;
        check(s);
        return s;
      }
      const q = Object.getOwnPropertyDescriptor(tx, "query");
      if (!q || !("value" in q) || typeof q.value !== "function") return fail();
      const originalQuery: MediaPersistenceTransaction["query"] = q.value;
      const state: State = {
        tx,
        originalQuery,
        raw: originalQuery.bind(tx),
        query: originalQuery.bind(tx),
        observedAt: observedAt ?? "",
        deadline: validUntil ?? "",
        latest: observedAt ?? "",
        mode,
        busy: true,
        ready: false,
        failed: false,
        pending: 0,
        asyncCalls: 0,
        asyncComplete: false,
        finalCalls: 0,
        finalComplete: false,
        onCommit: null,
        binding: null,
      };
      s = state;
      states.set(tx, s);
      actualTransactions.set(tx, tx);
      s.query = async <Row>(sql: string, values: readonly unknown[]) => {
        check(state);
        state.pending++;
        try {
          const result = await state.raw<Row>(sql, values);
          check(state);
          return result;
        } catch {
          return poison(state);
        } finally {
          state.pending--;
        }
      };
      try {
        if (
          (await register(
            tx,
            async () => {
              try {
                if (
                  ++state.asyncCalls !== 1 ||
                  state.busy ||
                  !state.ready ||
                  state.pending ||
                  !state.onCommit
                )
                  return poison(state);
                check(state);
                await state.onCommit();
                check(state);
                state.asyncComplete = true;
              } catch {
                return poison(state);
              }
            },
            () => {
              if (
                ++state.finalCalls !== 1 ||
                state.asyncCalls !== 1 ||
                !state.asyncComplete ||
                state.busy ||
                !state.ready ||
                state.pending
              )
                return poison(state);
              check(state);
              state.finalComplete = true;
            },
          )) !== undefined
        )
          return poison(s);
        check(s);
        return s;
      } catch {
        return poison(s);
      }
    }
    async function authorize(s: State) {
      check(s);
      const decision = await permission.holdUntilTransactionCompletes(s.tx, {
        actorKind: "System",
        action: "media.asset.promote",
        purposeCode: "MEDIA_IMAGE_PROMOTION",
        requiredFields: systemMediaImagePromotionRequiredFields,
        observedAt: s.observedAt,
        validUntil: s.deadline,
      });
      if (
        decision.effect !== "Allow" ||
        decision.observedAt !== s.observedAt ||
        decision.validUntil > s.deadline
      )
        return poison(s);
      s.deadline = decision.validUntil;
      check(s);
    }
    function read(row: Record<string, unknown>, s: State): MediaImageScanAdmission {
      const raw = closed(row, ["body", "digest", "coherent"]),
        a = parseMediaImageScanAdmission(raw.body);
      if (
        raw.coherent !== true ||
        raw.digest !== a.digest ||
        a.tenantReference !== tenantReference ||
        !equal(a.scope, scope) ||
        a.workloadReference !== workloadReference ||
        a.deploymentConfigurationDigest !== configurationDigest ||
        a.quarantineConfigurationDigest !== quarantineDigest ||
        a.providerAccount !== config.accountId ||
        a.region !== config.region ||
        a.protectionPlanArn !== config.protectionPlanArn ||
        a.admittedAt > check(s)
      )
        return poison(s);
      parseS3QuarantineImageScanEvent(a.scanEvent, config, a.object);
      return a;
    }
    async function admission(s: State, reference: string): Promise<MediaImageScanAdmission> {
      const row = one(
        await s.query(
          admissionSql +
            " WHERE admission_id=$1 AND tenant_id=$2 AND brand_id=$3 AND store_id IS NOT DISTINCT FROM $4 LIMIT 2",
          [reference, tenantReference, scope.brandReference, scope.storeReference],
        ),
      );
      if (!row) return poison(s);
      const a = read(row, s);
      if (a.admissionReference !== reference) return poison(s);
      return a;
    }
    function authorityInput(v: unknown): MediaImageProcessingAuthorityInput {
      const p = closed(copyMediaUploadStorageValue(v), [
        "phase",
        "sourceAssetVersionReference",
        "scanEventDigest",
        "admissionReference",
        "tenantReference",
        "scope",
        "systemActorReference",
        "actorKind",
        "action",
        "purposeCode",
        "requiredFields",
        "operationReference",
        "originalIntentDigest",
        "observedAt",
        "validUntil",
      ]);
      if (
        (p.phase !== "Plan" && p.phase !== "Complete") ||
        p.tenantReference !== tenantReference ||
        !equal(p.scope, scope) ||
        p.systemActorReference !== workloadReference ||
        p.actorKind !== "System" ||
        p.action !== "media.asset.promote" ||
        p.purposeCode !== "MEDIA_IMAGE_PROMOTION" ||
        !equal(p.requiredFields, systemMediaImagePromotionRequiredFields)
      )
        return fail();
      const observedAt = parseMediaInstant(p.observedAt),
        validUntil = parseMediaInstant(p.validUntil);
      if (
        validUntil <= observedAt ||
        Date.parse(validUntil) - Date.parse(observedAt) > 5000 ||
        (p.operationReference === null) !== (p.originalIntentDigest === null)
      )
        return fail();
      return Object.freeze({
        phase: p.phase,
        tenantReference,
        scope,
        systemActorReference: workloadReference,
        actorKind: "System",
        action: "media.asset.promote",
        purposeCode: "MEDIA_IMAGE_PROMOTION",
        requiredFields: systemMediaImagePromotionRequiredFields,
        sourceAssetVersionReference: parseAssetVersionReference(p.sourceAssetVersionReference),
        scanEventDigest: hash(p.scanEventDigest),
        admissionReference: parseMediaReferenceId(p.admissionReference),
        operationReference:
          p.operationReference === null ? null : parseMediaReferenceId(p.operationReference),
        originalIntentDigest: p.originalIntentDigest === null ? null : hash(p.originalIntentDigest),
        observedAt,
        validUntil,
      });
    }
    async function finalIntent(s: State) {
      const b = s.binding;
      if (!b?.operationReference || !b.originalIntentDigest) return poison(s);
      const a = await admission(s, b.admissionReference),
        row = one(
          await s.query(
            `SELECT intent_json body,intent_digest digest,scan_admission_id::text admission_reference,
       (tenant_id=$2 AND brand_id=$3 AND store_id IS NOT DISTINCT FROM $4 AND system_actor_id=$5
        AND source_asset_version_id=$6 AND scan_event_id=$7 AND source_binding_digest=$8
        AND operation_id::text=intent_json->>'operationReference') IS TRUE coherent
       FROM bop_media.image_processing_intent WHERE operation_id=$1 LIMIT 2`,
            [
              b.operationReference,
              tenantReference,
              scope.brandReference,
              scope.storeReference,
              workloadReference,
              b.sourceAssetVersionReference,
              a.eventId,
              a.sourceBindingDigest,
            ],
          ),
        );
      if (!row) return poison(s);
      const r = closed(row, ["body", "digest", "admission_reference", "coherent"]),
        body = closed(r.body, [
          "profile",
          "operationReference",
          "tenantReference",
          "scope",
          "systemActorReference",
          "sourceBindingDigest",
          "source",
          "plan",
          "createdAt",
          "auditId",
          "correlationId",
          "admissionReference",
        ]),
        source = closed(body.source, [
          "tenantReference",
          "session",
          "asset",
          "assetVersion",
          "object",
          "scanEvent",
        ]);
      if (
        r.coherent !== true ||
        r.digest !== b.originalIntentDigest ||
        r.admission_reference !== a.admissionReference ||
        mediaImageScanAdmissionHash(body) !== b.originalIntentDigest ||
        body.profile !== "MEDIA_IMAGE_PROCESSING_INTENT_V1" ||
        body.operationReference !== b.operationReference ||
        body.tenantReference !== tenantReference ||
        !equal(body.scope, scope) ||
        body.systemActorReference !== workloadReference ||
        body.admissionReference !== a.admissionReference ||
        body.sourceBindingDigest !== a.sourceBindingDigest ||
        source.tenantReference !== tenantReference ||
        !equal(source.object, a.object) ||
        !equal(source.scanEvent, a.scanEvent)
      )
        return poison(s);
      check(s);
    }
    const authority = Object.freeze({
      async holdUntilTransactionCompletes(
        tx: MediaPersistenceTransaction,
        value: MediaImageProcessingAuthorityInput,
      ) {
        let b: MediaImageProcessingAuthorityInput | undefined;
        try {
          b = authorityInput(value);
        } catch {
          /* Register poison before refusal. */
        }
        const s = await open(tx, b?.observedAt, b?.validUntil, "Hold");
        try {
          if (!b || b.observedAt > check(s)) return poison(s);
          if (s.binding) {
            const old = s.binding;
            if (
              old.phase !== b.phase ||
              old.sourceAssetVersionReference !== b.sourceAssetVersionReference ||
              old.scanEventDigest !== b.scanEventDigest ||
              old.admissionReference !== b.admissionReference ||
              (old.operationReference !== null &&
                (old.operationReference !== b.operationReference ||
                  old.originalIntentDigest !== b.originalIntentDigest))
            )
              return poison(s);
          }
          s.binding = b;
          await authorize(s);
          const a = await admission(s, b.admissionReference);
          if (
            a.sourceAssetVersionReference !== b.sourceAssetVersionReference ||
            a.scanEventDigest !== b.scanEventDigest
          )
            return poison(s);
          s.onCommit = () => finalIntent(s);
          s.ready = true;
          return Object.freeze({ observedAt: s.observedAt, validUntil: s.deadline });
        } catch {
          return poison(s);
        } finally {
          s.busy = false;
        }
      },
    });
    return Object.freeze({
      authority,
      async admit(value: MediaImageScanDelivery) {
        let delivery: MediaImageScanDelivery | undefined, observedAt: string | undefined;
        try {
          delivery = parseMediaImageScanDelivery(value);
          observedAt = parseMediaInstant(now());
        } catch {
          /* Fail after the rejecting guard is registered. */
        }
        let state: State | undefined,
          calls = 0,
          expected:
            | Readonly<{
                admissionReference: string;
                sourceAssetVersionReference: string;
                scanEvent: unknown;
                correlationId: string;
              }>
            | undefined;
        try {
          const result = await run(async (tx) => {
            if (++calls !== 1) {
              if (state) state.failed = true;
              return fail();
            }
            const s = await open(
              tx,
              observedAt,
              observedAt ? new Date(Date.parse(observedAt) + 5000).toISOString() : undefined,
              "Admit",
            );
            state = s;
            try {
              if (
                !delivery ||
                delivery.transport.deploymentConfigurationDigest !== configurationDigest ||
                delivery.transport.receivedAt > check(s)
              )
                return poison(s);
              await authorize(s);
              const loaded = await resolveMediaImageProcessingSource(
                  Object.freeze({ query: s.query }),
                  config,
                  delivery.scanEvent,
                ),
                event = closed(delivery.scanEvent, [
                  "version",
                  "id",
                  "account",
                  "region",
                  "time",
                  "resources",
                  "source",
                  "detail-type",
                  "detail",
                ]);
              await s.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
                `MediaScanAdmission:${config.accountId}:${config.region}:${String(event.id)}`,
              ]);
              const prior = one(
                await s.query(
                  admissionSql + " WHERE provider_account=$1 AND region=$2 AND event_id=$3 LIMIT 2",
                  [config.accountId, config.region, event.id],
                ),
              );
              let a: MediaImageScanAdmission;
              if (prior) {
                a = read(prior, s);
                if (
                  !equal(a.scanEvent, delivery.scanEvent) ||
                  a.sourceAssetVersionReference !== loaded.source.assetVersion.assetVersionId ||
                  a.sourceBindingDigest !== loaded.sourceBindingDigest ||
                  !equal(a.object, loaded.source.object) ||
                  a.transport.queueArn !== delivery.transport.queueArn ||
                  a.transport.queueCreatedAt !== delivery.transport.queueCreatedAt ||
                  a.transport.queuePolicyDigest !== delivery.transport.queuePolicyDigest
                )
                  return poison(s);
              } else {
                a = buildMediaImageScanAdmission({
                  profile: "MEDIA_IMAGE_SCAN_ADMISSION_V1",
                  admissionReference: uuidV7(),
                  tenantReference,
                  scope,
                  workloadReference,
                  deploymentConfigurationDigest: configurationDigest,
                  quarantineConfigurationDigest: quarantineDigest,
                  providerAccount: config.accountId,
                  region: config.region,
                  protectionPlanArn: config.protectionPlanArn,
                  eventId: String(event.id),
                  scanEventDigest: mediaImageScanAdmissionHash(delivery.scanEvent),
                  scanEvent: delivery.scanEvent,
                  sourceAssetVersionReference: loaded.source.assetVersion.assetVersionId,
                  sourceBindingDigest: loaded.sourceBindingDigest,
                  object: loaded.source.object,
                  transport: delivery.transport,
                  admittedAt: check(s),
                  auditReference: uuidV7(),
                  correlationId: uuidV7(),
                });
                await s.query("SAVEPOINT media_scan_admission", []);
                try {
                  const inserted = await s.query(
                    `INSERT INTO bop_media.image_scan_admission
                  (admission_id,tenant_id,brand_id,store_id,workload_id,deployment_config_digest,quarantine_config_digest,provider_account,region,protection_plan_arn,event_id,event_digest,
                   source_asset_version_id,source_binding_digest,bucket,key,version_id,etag,admitted_at,audit_id,correlation_id,snapshot_json,digest)
                  VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23)`,
                    [
                      a.admissionReference,
                      tenantReference,
                      scope.brandReference,
                      scope.storeReference,
                      workloadReference,
                      configurationDigest,
                      quarantineDigest,
                      config.accountId,
                      config.region,
                      config.protectionPlanArn,
                      a.eventId,
                      a.scanEventDigest,
                      a.sourceAssetVersionReference,
                      a.sourceBindingDigest,
                      a.object.bucket,
                      a.object.key,
                      a.object.versionId,
                      a.object.etag,
                      a.admittedAt,
                      a.auditReference,
                      a.correlationId,
                      canonicalizeRfc8785(a),
                      a.digest,
                    ],
                  );
                  if (inserted.rowCount !== 1) return poison(s);
                  await appendAuditRecordInTransaction(
                    { query: s.query },
                    {
                      auditId: a.auditReference,
                      brandId: scope.brandReference,
                      ...(scope.storeReference === null ? {} : { storeId: scope.storeReference }),
                      actor: { type: "System" },
                      actionCode: "MEDIA_IMAGE_SCAN_ADMITTED",
                      targetType: "MediaAssetVersion",
                      targetId: a.sourceAssetVersionReference,
                      reasonCode: "MEDIA_IMAGE_SCAN_ADMITTED",
                      correlationId: a.correlationId,
                      occurredAt: a.admittedAt,
                      sourceChannel: "WORKER",
                      dataClassification: "Confidential",
                      retentionPolicyCode: "MEDIA_OPERATION_AUDIT",
                      retentionPolicyVersion: 1,
                    },
                  );
                  await s.query("RELEASE SAVEPOINT media_scan_admission", []);
                } catch {
                  s.failed = true;
                  await s.raw("ROLLBACK TO SAVEPOINT media_scan_admission", []);
                  await s.raw("RELEASE SAVEPOINT media_scan_admission", []);
                  return fail();
                }
              }
              expected = Object.freeze({
                admissionReference: a.admissionReference,
                sourceAssetVersionReference: a.sourceAssetVersionReference,
                scanEvent: a.scanEvent,
                correlationId: a.correlationId,
              });
              s.onCommit = () => authorize(s);
              s.ready = true;
              check(s);
              return expected;
            } catch {
              return poison(s);
            } finally {
              s.busy = false;
            }
          });
          if (
            !state ||
            calls !== 1 ||
            state.failed ||
            !state.ready ||
            !state.asyncComplete ||
            !state.finalComplete ||
            result !== expected
          )
            return fail();
          return result;
        } catch (error) {
          if (state) state.failed = true;
          const d =
            error && typeof error === "object"
              ? Object.getOwnPropertyDescriptor(error, "code")
              : undefined;
          if (d && "value" in d && d.value === "COMMIT_OUTCOME_UNKNOWN")
            throw new MediaImageScanAdmissionError("MEDIA_IMAGE_SCAN_ADMISSION_OUTCOME_UNKNOWN");
          return fail();
        }
      },
    });
  } catch {
    return fail();
  }
}
