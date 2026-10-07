import { v7 as uuidV7 } from "uuid";
import { appendAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaAsset,
  createMediaAssetVersion,
  parseMediaInstant,
  parseMediaReferenceId,
  parseAssetVersionReference,
  parseObjectEvidenceReference,
  parseMediaChecksum,
  parseMediaVersion,
  type MediaAsset,
  type MediaAssetVersion,
} from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import {
  createMediaImagePromotionPlan,
  mediaImagePromotionPlanDigest,
  parseMediaImagePromotionPlan,
  parseMediaImagePromotionResult,
  type MediaImagePromotionPlan,
  type MediaImagePromotionResult,
} from "../processing/media-image-promotion.js";
import {
  parseS3QuarantineImageConfig,
  type S3QuarantineImageConfig,
  type S3QuarantineImageReadInput,
} from "../provider/s3-quarantine-image-source.js";
import { createS3ImagePromotionWriter } from "../provider/s3-image-promotion-writer.js";
import { loadMediaImageProcessingSource } from "./media-image-processing-source.js";
import {
  createMediaImageProcessingTransaction,
  type MediaImageProcessingTransactionOptions,
  type MediaImageProcessingTransactionContext,
} from "./media-image-processing-transaction.js";
import type { MediaPersistenceTransaction } from "./media-upload-store.js";

export interface MediaImageProcessingIntent {
  readonly profile: "MEDIA_IMAGE_PROCESSING_INTENT_V1";
  readonly operationReference: string;
  readonly tenantReference: string;
  readonly scope: MediaImagePromotionPlan["scope"];
  readonly systemActorReference: string;
  readonly sourceBindingDigest: string;
  readonly source: S3QuarantineImageReadInput;
  readonly plan: MediaImagePromotionPlan;
  readonly createdAt: string;
  readonly auditId: string;
  readonly correlationId: string;
  readonly admissionReference: string;
}
export interface MediaImageProcessingReceipt {
  readonly asset: MediaAsset;
  readonly assetVersion: MediaAssetVersion;
}
export interface MediaImageProcessingRequest {
  readonly sourceAssetVersionReference: string;
  readonly scanEvent: unknown;
  readonly admissionReference: string;
  readonly correlationId: string;
}
export interface MediaImageProcessingStoreOptions extends MediaImageProcessingTransactionOptions {
  readonly quarantineConfig: S3QuarantineImageConfig;
  readonly destination: MediaImagePromotionPlan["destination"];
}
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const fail = (): never => {
  throw Object.assign(new Error("Media image processing unavailable"), {
    code: "MEDIA_IMAGE_PROCESSING_UNAVAILABLE",
  });
};
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const r = copyMediaUploadStorageValue(value);
  if (
    !r ||
    typeof r !== "object" ||
    Array.isArray(r) ||
    Object.keys(r).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(r, key))
  )
    return fail();
  return r as Record<string, unknown>;
}
function one(value: { readonly rows: readonly unknown[] }): Record<string, unknown> | null {
  const rows = copyMediaUploadStorageValue(value.rows);
  if (!Array.isArray(rows) || rows.length > 1) return fail();
  return rows.length === 0 ? null : (rows[0] as Record<string, unknown>);
}
function inserted(value: { readonly rowCount?: number | null }): void {
  if (value.rowCount !== 1) return fail();
}
function scanId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && /^[A-Za-z0-9-]{1,128}$/u.test(id) ? id : fail();
}
function intent(value: unknown): MediaImageProcessingIntent {
  const r = record(value, [
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
  ]);
  const plan = parseMediaImagePromotionPlan(r.plan);
  if (
    r.profile !== "MEDIA_IMAGE_PROCESSING_INTENT_V1" ||
    r.operationReference !== plan.operationReference ||
    r.tenantReference !== plan.tenantReference ||
    !equal(r.scope, plan.scope) ||
    r.sourceBindingDigest !== plan.sourceBindingDigest
  )
    return fail();
  // Full source validation is performed against immutable owning rows, never
  // inferred from these copied JSON fields or from an event's claimed origin.
  return Object.freeze({
    profile: "MEDIA_IMAGE_PROCESSING_INTENT_V1",
    operationReference: plan.operationReference,
    tenantReference: plan.tenantReference,
    scope: plan.scope,
    systemActorReference: parseMediaReferenceId(r.systemActorReference),
    sourceBindingDigest: plan.sourceBindingDigest,
    source: r.source as S3QuarantineImageReadInput,
    plan,
    createdAt: parseMediaInstant(r.createdAt),
    auditId: parseMediaReferenceId(r.auditId),
    correlationId: parseMediaReferenceId(r.correlationId),
    admissionReference: parseMediaReferenceId(r.admissionReference),
  });
}
const intentSql = `SELECT intent_json body,intent_digest digest,
 (tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND system_actor_id=$4
 AND operation_id::text=intent_json->>'operationReference' AND asset_id::text=intent_json->'plan'->>'assetReference'
 AND source_asset_version_id::text=intent_json->'plan'->>'sourceAssetVersionReference'
 AND target_asset_version_id::text=intent_json->'plan'->>'targetAssetVersionReference'
 AND expected_asset_version=(intent_json->'plan'->>'expectedAssetVersion')::bigint
 AND scan_event_id=intent_json->'source'->'scanEvent'->>'id'
 AND scan_admission_id::text=intent_json->>'admissionReference'
 AND source_binding_digest=intent_json->>'sourceBindingDigest'
 AND audit_id::text=intent_json->>'auditId' AND recorded_at=(intent_json->>'createdAt')::timestamptz) IS TRUE coherent,
 plan_digest FROM bop_media.image_processing_intent`;

/** Private owning store. Intent is durable before any Provider I/O. Completion
 * creates a new derivative version and never edits the quarantine history. */
export function createMediaImageProcessingStore(options: MediaImageProcessingStoreOptions) {
  const config = parseS3QuarantineImageConfig(options.quarantineConfig),
    systemActorReference = parseMediaReferenceId(options.systemActorReference),
    destination = copyMediaUploadStorageValue(
      options.destination,
    ) as MediaImagePromotionPlan["destination"],
    kernel = createMediaImageProcessingTransaction({
      tenantReference: options.tenantReference,
      scope: options.scope,
      systemActorReference: options.systemActorReference,
      clock: options.clock,
      transactions: options.transactions,
      registerBeforeCommit: options.registerBeforeCommit,
      authority: options.authority,
    });
  if (config.tenantReference !== options.tenantReference || !equal(config.scope, options.scope))
    return fail();
  const scopeValues = [
    config.tenantReference,
    config.scope.brandReference,
    config.scope.storeReference,
    systemActorReference,
  ];
  async function readIntent(
    row: Record<string, unknown>,
    tx: MediaPersistenceTransaction,
    at: string,
  ) {
    const i = intent(row.body);
    if (
      row.coherent !== true ||
      row.digest !== digest(i) ||
      row.plan_digest !== mediaImagePromotionPlanDigest(i.plan) ||
      i.tenantReference !== config.tenantReference ||
      !equal(i.scope, config.scope) ||
      i.systemActorReference !== systemActorReference ||
      !equal(i.plan.destination, destination) ||
      i.createdAt > at
    )
      return fail();
    const loaded = await loadMediaImageProcessingSource(
      tx,
      config,
      i.plan.sourceAssetVersionReference,
      i.source.scanEvent,
    );
    if (!equal(loaded.source, i.source) || loaded.sourceBindingDigest !== i.sourceBindingDigest)
      return fail();
    return i;
  }
  async function completion(
    tx: MediaPersistenceTransaction,
    i: MediaImageProcessingIntent,
    at: string,
  ): Promise<MediaImageProcessingReceipt | null> {
    const row = one(
      await tx.query(
        `SELECT completion_json result,completion_digest digest,asset_snapshot_json asset,
      new_version_json version,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') recorded_at,
      (tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND system_actor_id=$4
       AND asset_id=$6 AND source_asset_version_id=$7 AND target_asset_version_id=$8) IS TRUE coherent
      FROM bop_media.image_processing_completion WHERE operation_id=$5 LIMIT 2`,
        [
          ...scopeValues,
          i.operationReference,
          i.plan.assetReference,
          i.plan.sourceAssetVersionReference,
          i.plan.targetAssetVersionReference,
        ],
      ),
    );
    if (!row) return null;
    const result = parseMediaImagePromotionResult(row.result, i.plan, i.source),
      recordedAt = parseMediaInstant(row.recorded_at),
      receipt = promotedReceipt(i, result, recordedAt);
    if (
      row.coherent !== true ||
      row.digest !== digest(result) ||
      recordedAt < result.completedAt ||
      recordedAt > at ||
      !equal(row.asset, receipt.asset) ||
      !equal(row.version, receipt.assetVersion) ||
      result.sourceEvidence.kmsKeyArn !== config.kmsKeyArn
    )
      return fail();
    const version = one(
      await tx.query(
        `SELECT snapshot_json snapshot,(tenant_id=$1 AND brand_id=$2
      AND store_id IS NOT DISTINCT FROM $3 AND asset_id=$5 AND upload_session_id=$6 AND version=$7
      AND created_at=$8::timestamptz) IS TRUE coherent FROM bop_media.asset_version WHERE asset_version_id=$4 LIMIT 2`,
        [
          config.tenantReference,
          config.scope.brandReference,
          config.scope.storeReference,
          i.plan.targetAssetVersionReference,
          i.plan.assetReference,
          i.source.session.uploadSessionId,
          i.plan.expectedAssetVersion + 1,
          recordedAt,
        ],
      ),
    );
    if (!version || version.coherent !== true || !equal(version.snapshot, receipt.assetVersion))
      return fail();
    const rows = copyMediaUploadStorageValue(
      (
        await tx.query(
          `SELECT snapshot_json snapshot,
      (tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3
       AND content_type=snapshot_json->>'contentType' AND width=(snapshot_json->>'width')::integer
       AND height=(snapshot_json->>'height')::integer AND byte_size=(snapshot_json->>'byteSize')::integer
       AND checksum=snapshot_json->>'checksum' AND object_evidence_reference::text=snapshot_json->>'objectEvidenceReference'
       AND provider_object_version::text=snapshot_json->>'providerObjectVersion') IS TRUE coherent
      FROM bop_media.image_rendition WHERE asset_version_id=$4 ORDER BY width,content_type`,
          [
            config.tenantReference,
            config.scope.brandReference,
            config.scope.storeReference,
            i.plan.targetAssetVersionReference,
          ],
        )
      ).rows,
    );
    if (
      !Array.isArray(rows) ||
      rows.length !== 6 ||
      rows.some((r, n) => {
        const v = record(r, ["snapshot", "coherent"]);
        return v.coherent !== true || !equal(v.snapshot, result.renditions[n]);
      })
    )
      return fail();
    return receipt;
  }
  function promotedReceipt(
    i: MediaImageProcessingIntent,
    result: MediaImagePromotionResult,
    recordedAt: string,
  ): MediaImageProcessingReceipt {
    const representative = result.renditions.find(
      (r) => r.contentType === "image/jpeg" && r.width === 1280,
    );
    if (!representative || result.completedAt < i.createdAt || result.completedAt > recordedAt)
      return fail();
    return Object.freeze({
      asset: createMediaAsset({
        ...i.source.asset,
        currentVersionReference: parseAssetVersionReference(i.plan.targetAssetVersionReference),
        version: parseMediaVersion(i.plan.expectedAssetVersion + 1),
      }),
      assetVersion: createMediaAssetVersion({
        assetVersionId: parseAssetVersionReference(i.plan.targetAssetVersionReference),
        assetId: i.source.asset.assetId,
        version: parseMediaVersion(i.plan.expectedAssetVersion + 1),
        objectEvidenceReference: parseObjectEvidenceReference(
          representative.objectEvidenceReference,
        ),
        providerObjectVersion: parseMediaReferenceId(representative.providerObjectVersion),
        byteSize: representative.byteSize,
        checksum: parseMediaChecksum(representative.checksum),
        contentType: representative.contentType,
        checkState: "Clean",
        readinessState: "Ready",
        createdAt: parseMediaInstant(recordedAt),
      }),
    });
  }
  async function audit(
    tx: MediaPersistenceTransaction,
    i: MediaImageProcessingIntent,
    complete: boolean,
    at: string,
    auditId: string,
  ) {
    const actionCode = complete
      ? "MEDIA_IMAGE_PROCESSING_COMPLETED"
      : "MEDIA_IMAGE_PROCESSING_PLANNED";
    await appendAuditRecordInTransaction(tx, {
      auditId,
      brandId: config.scope.brandReference,
      ...(config.scope.storeReference === null ? {} : { storeId: config.scope.storeReference }),
      actor: { type: "System" },
      actionCode,
      targetType: "MediaAsset",
      targetId: i.plan.assetReference,
      reasonCode: actionCode,
      correlationId: i.correlationId,
      occurredAt: at,
      sourceChannel: "WORKER",
      dataClassification: "Confidential",
      retentionPolicyCode: "MEDIA_OPERATION_AUDIT",
      retentionPolicyVersion: 1,
    });
  }
  async function root(
    ctx: MediaImageProcessingTransactionContext,
    assetReference: string,
  ): Promise<MediaAsset> {
    const r = one(
      await ctx.tx.query(
        `SELECT snapshot_json snapshot,(tenant_id=$1 AND brand_id=$2
      AND store_id IS NOT DISTINCT FROM $3 AND asset_id::text=snapshot_json->>'assetId'
      AND version=(snapshot_json->>'version')::bigint
      AND current_version_id::text IS NOT DISTINCT FROM snapshot_json->>'currentVersionReference') IS TRUE coherent
      FROM bop_media.asset WHERE asset_id=$4 FOR UPDATE`,
        [
          config.tenantReference,
          config.scope.brandReference,
          config.scope.storeReference,
          assetReference,
        ],
      ),
    );
    if (!r || r.coherent !== true) return fail();
    return createMediaAsset(copyMediaUploadStorageValue(r.snapshot) as MediaAsset);
  }
  const plan = async (input: MediaImageProcessingRequest) => {
    const r = record(input, [
        "sourceAssetVersionReference",
        "scanEvent",
        "admissionReference",
        "correlationId",
      ]),
      sourceAssetVersionReference = parseMediaReferenceId(r.sourceAssetVersionReference),
      admissionReference = parseMediaReferenceId(r.admissionReference),
      correlationId = parseMediaReferenceId(r.correlationId),
      eventId = scanId(r.scanEvent);
    return kernel.run(
      {
        phase: "Plan",
        sourceAssetVersionReference,
        scanEventDigest: digest(r.scanEvent),
        admissionReference,
      },
      async (ctx) => {
        await ctx.tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "MediaImageProcessing:" + sourceAssetVersionReference + ":" + eventId,
        ]);
        const found = one(
          await ctx.tx.query(
            intentSql + " WHERE source_asset_version_id=$5 AND scan_event_id=$6 LIMIT 2",
            [...scopeValues, sourceAssetVersionReference, eventId],
          ),
        );
        if (found) {
          const i = await readIntent(found, ctx.tx, ctx.now());
          if (
            !equal(i.source.scanEvent, r.scanEvent) ||
            i.admissionReference !== admissionReference
          )
            return fail();
          await ctx.bind(i.operationReference, digest(i));
          return Object.freeze({ intent: i, completion: await completion(ctx.tx, i, ctx.now()) });
        }
        const loaded = await loadMediaImageProcessingSource(
            ctx.tx,
            config,
            sourceAssetVersionReference,
            r.scanEvent,
          ),
          current = await root(ctx, loaded.source.asset.assetId),
          createdAt = ctx.now(),
          operationReference = uuidV7();
        if (
          current.version >= Number.MAX_SAFE_INTEGER ||
          !equal({ ...current, version: 1, currentVersionReference: null }, loaded.source.asset)
        )
          return fail();
        const promotion = createMediaImagePromotionPlan({
          operationReference,
          tenantReference: config.tenantReference,
          scope: config.scope,
          assetReference: current.assetId,
          sourceAssetVersionReference,
          targetAssetVersionReference: uuidV7(),
          expectedAssetVersion: current.version,
          sourceBindingDigest: loaded.sourceBindingDigest,
          destination,
        });
        const i = intent({
          profile: "MEDIA_IMAGE_PROCESSING_INTENT_V1",
          operationReference,
          tenantReference: config.tenantReference,
          scope: config.scope,
          systemActorReference,
          sourceBindingDigest: loaded.sourceBindingDigest,
          source: loaded.source,
          plan: promotion,
          createdAt,
          auditId: uuidV7(),
          correlationId,
          admissionReference,
        });
        await ctx.bind(operationReference, digest(i));
        inserted(
          await ctx.tx.query(
            `INSERT INTO bop_media.image_processing_intent(operation_id,tenant_id,brand_id,store_id,system_actor_id,
        asset_id,source_asset_version_id,target_asset_version_id,expected_asset_version,scan_event_id,source_binding_digest,plan_digest,
        intent_digest,intent_json,recorded_at,audit_id,scan_admission_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17)`,
            [
              operationReference,
              ...scopeValues,
              current.assetId,
              sourceAssetVersionReference,
              promotion.targetAssetVersionReference,
              current.version,
              eventId,
              i.sourceBindingDigest,
              mediaImagePromotionPlanDigest(promotion),
              digest(i),
              canonicalizeRfc8785(i),
              createdAt,
              i.auditId,
              admissionReference,
            ],
          ),
        );
        await audit(ctx.tx, i, false, createdAt, i.auditId);
        return Object.freeze({ intent: i, completion: null });
      },
    );
  };
  const complete = async (value: {
    readonly intent: MediaImageProcessingIntent;
    readonly result: MediaImagePromotionResult;
  }) => {
    const captured = record(value, ["intent", "result"]),
      submitted = intent(captured.intent);
    return kernel.run(
      {
        phase: "Complete",
        sourceAssetVersionReference: submitted.plan.sourceAssetVersionReference,
        scanEventDigest: digest(submitted.source.scanEvent),
        admissionReference: submitted.admissionReference,
      },
      async (ctx) => {
        await ctx.tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "MediaImageProcessing:" +
            submitted.plan.sourceAssetVersionReference +
            ":" +
            scanId(submitted.source.scanEvent),
        ]);
        const found = one(
          await ctx.tx.query(intentSql + " WHERE operation_id=$5 LIMIT 2", [
            ...scopeValues,
            submitted.operationReference,
          ]),
        );
        if (!found) return fail();
        const i = await readIntent(found, ctx.tx, ctx.now());
        if (!equal(i, submitted)) return fail();
        await ctx.bind(i.operationReference, digest(i));
        const prior = await completion(ctx.tx, i, ctx.now());
        if (prior) return prior;
        const result = parseMediaImagePromotionResult(captured.result, i.plan, i.source),
          current = await root(ctx, i.plan.assetReference),
          recordedAt = ctx.now(),
          receipt = promotedReceipt(i, result, recordedAt),
          auditId = uuidV7();
        if (
          result.sourceEvidence.kmsKeyArn !== config.kmsKeyArn ||
          current.version !== i.plan.expectedAssetVersion ||
          !equal({ ...current, version: 1, currentVersionReference: null }, i.source.asset)
        )
          return fail();
        inserted(
          await ctx.tx.query(
            `INSERT INTO bop_media.asset_version(asset_version_id,tenant_id,brand_id,store_id,asset_id,
        upload_session_id,version,created_at,snapshot_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
            [
              i.plan.targetAssetVersionReference,
              config.tenantReference,
              config.scope.brandReference,
              config.scope.storeReference,
              i.plan.assetReference,
              i.source.session.uploadSessionId,
              receipt.assetVersion.version,
              recordedAt,
              canonicalizeRfc8785(receipt.assetVersion),
            ],
          ),
        );
        for (const rendition of result.renditions)
          inserted(
            await ctx.tx.query(
              `INSERT INTO bop_media.image_rendition(asset_version_id,
        tenant_id,brand_id,store_id,content_type,width,height,byte_size,checksum,object_evidence_reference,provider_object_version,snapshot_json)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
              [
                i.plan.targetAssetVersionReference,
                config.tenantReference,
                config.scope.brandReference,
                config.scope.storeReference,
                rendition.contentType,
                rendition.width,
                rendition.height,
                rendition.byteSize,
                rendition.checksum,
                rendition.objectEvidenceReference,
                rendition.providerObjectVersion,
                canonicalizeRfc8785(rendition),
              ],
            ),
          );
        inserted(
          await ctx.tx.query(
            `INSERT INTO bop_media.image_processing_completion(operation_id,tenant_id,brand_id,store_id,system_actor_id,
        asset_id,source_asset_version_id,target_asset_version_id,recorded_at,completion_digest,completion_json,asset_snapshot_json,new_version_json,audit_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14)`,
            [
              i.operationReference,
              ...scopeValues,
              i.plan.assetReference,
              i.plan.sourceAssetVersionReference,
              i.plan.targetAssetVersionReference,
              recordedAt,
              digest(result),
              canonicalizeRfc8785(result),
              canonicalizeRfc8785(receipt.asset),
              canonicalizeRfc8785(receipt.assetVersion),
              auditId,
            ],
          ),
        );
        inserted(
          await ctx.tx.query(
            `UPDATE bop_media.asset SET version=$6,current_version_id=$7,snapshot_json=$8::jsonb
        WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3 AND asset_id=$4 AND version=$5`,
            [
              config.tenantReference,
              config.scope.brandReference,
              config.scope.storeReference,
              i.plan.assetReference,
              i.plan.expectedAssetVersion,
              receipt.asset.version,
              i.plan.targetAssetVersionReference,
              canonicalizeRfc8785(receipt.asset),
            ],
          ),
        );
        await audit(ctx.tx, i, true, recordedAt, auditId);
        return receipt;
      },
    );
  };
  return Object.freeze({ plan, complete });
}

/** Actual owning composition; SDK injection is only an infrastructure test seam.
 * A stored completion is recovered before decoding or touching object storage. */
export function createMediaImageProcessingRuntime(
  options: MediaImageProcessingStoreOptions & {
    readonly sdk?: Parameters<typeof createS3ImagePromotionWriter>[0]["sdk"];
  },
) {
  const store = createMediaImageProcessingStore(options),
    writer = createS3ImagePromotionWriter({
      quarantineConfig: options.quarantineConfig,
      clock: options.clock,
      ...(options.sdk ? { sdk: options.sdk } : {}),
    });
  return Object.freeze({
    close: () => writer.close(),
    process: async (input: MediaImageProcessingRequest, signal?: AbortSignal) => {
      const state = await store.plan(input);
      if (state.completion) return state.completion;
      const result = await writer.process(
        { source: state.intent.source, plan: state.intent.plan },
        signal,
      );
      return store.complete({ intent: state.intent, result });
    },
  });
}
