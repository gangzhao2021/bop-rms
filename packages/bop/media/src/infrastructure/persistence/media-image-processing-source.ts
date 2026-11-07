import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaAsset,
  parseAssetVersionReference,
  parseMediaInstant,
  type MediaAsset,
} from "../../contracts/media.js";
import {
  copyMediaUploadStorageValue,
  mediaUploadStorageIntentDigest,
  mediaUploadStorageResult,
  parseMediaUploadStorageCommand,
} from "../../contracts/media-upload-storage.js";
import {
  parseS3QuarantineImageConfig,
  parseS3QuarantineImageScanEvent,
  type S3QuarantineImageConfig,
  type S3QuarantineImageReadInput,
} from "../provider/s3-quarantine-image-source.js";
import { finalBinding, uploadBinding } from "./s3-image-upload-runtime.js";
import type { MediaPersistenceTransaction } from "./media-upload-store.js";

export class MediaImageProcessingUnavailableError extends Error {
  readonly code = "MEDIA_IMAGE_PROCESSING_UNAVAILABLE";
  constructor() {
    super("Media image processing is unavailable");
    this.name = "MediaImageProcessingUnavailableError";
  }
}
const fail = (): never => {
  throw new MediaImageProcessingUnavailableError();
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const digest = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(value, key))
  )
    return fail();
  return value as Record<string, unknown>;
}
function one(value: unknown): Record<string, unknown> {
  const descriptor =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (!descriptor || !("value" in descriptor)) return fail();
  const rows = copyMediaUploadStorageValue(descriptor.value);
  if (!Array.isArray(rows) || rows.length !== 1) return fail();
  return closed(rows[0], [
    "final_binding",
    "final_digest",
    "final_command",
    "final_result",
    "final_intent_digest",
    "final_recorded_at",
    "upload_binding",
    "upload_digest",
    "create_command",
    "create_result",
    "create_intent_digest",
    "create_recorded_at",
    "session",
    "asset_version",
    "current_asset",
    "coherent",
  ]);
}

// One owning statement joins the immutable receipts and bindings to the actual
// source rows. The caller already holds System authority and establishes RLS.
// No caller-supplied Actor is substituted for the original uploading User.
const sourceSql = `SELECT f.binding_json final_binding,f.binding_digest final_digest,
 fo.command_json final_command,fo.result_json final_result,fo.intent_digest final_intent_digest,
 to_char(fo.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') final_recorded_at,
 u.binding_json upload_binding,u.binding_digest upload_digest,
 co.command_json create_command,co.result_json create_result,co.intent_digest create_intent_digest,
 to_char(co.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') create_recorded_at,
 s.snapshot_json session,v.snapshot_json asset_version,a.snapshot_json current_asset,
 (f.tenant_id=$1 AND f.brand_id=$2 AND f.store_id IS NOT DISTINCT FROM $3 AND f.asset_version_id=$4
 AND u.tenant_id=f.tenant_id AND u.brand_id=f.brand_id AND u.store_id IS NOT DISTINCT FROM f.store_id AND u.actor_id=f.actor_id
 AND fo.tenant_id=f.tenant_id AND fo.brand_id=f.brand_id AND fo.store_id IS NOT DISTINCT FROM f.store_id AND fo.actor_id=f.actor_id
 AND co.tenant_id=f.tenant_id AND co.brand_id=f.brand_id AND co.store_id IS NOT DISTINCT FROM f.store_id AND co.actor_id=f.actor_id
 AND s.tenant_id=f.tenant_id AND s.brand_id=f.brand_id AND s.store_id IS NOT DISTINCT FROM f.store_id AND s.actor_id=f.actor_id
 AND v.tenant_id=f.tenant_id AND v.brand_id=f.brand_id AND v.store_id IS NOT DISTINCT FROM f.store_id
 AND a.tenant_id=f.tenant_id AND a.brand_id=f.brand_id AND a.store_id IS NOT DISTINCT FROM f.store_id
 AND fo.action_code='FinalizeAsset' AND co.action_code='CreateUpload' AND fo.object_binding_required AND co.object_binding_required
 AND fo.operation_id::text=fo.command_json#>>'{input,idempotencyKey}' AND co.operation_id::text=co.command_json#>>'{input,idempotencyKey}'
 AND fo.actor_id::text=fo.command_json->>'actorReference' AND co.actor_id::text=co.command_json->>'actorReference'
 AND fo.upload_session_id=f.upload_session_id AND co.upload_session_id=f.upload_session_id
 AND fo.asset_id=f.asset_id AND fo.asset_version_id=f.asset_version_id AND co.asset_id IS NULL AND co.asset_version_id IS NULL
 AND fo.audit_id::text=fo.command_json#>>'{input,audit,auditId}' AND co.audit_id::text=co.command_json#>>'{input,audit,auditId}'
 AND f.recorded_at=fo.recorded_at AND u.recorded_at=co.recorded_at
 AND u.grant_reference::text=co.result_json#>>'{session,grantReference}'
 AND u.bucket=u.binding_json#>>'{config,bucket}' AND u.key=u.binding_json->>'key'
 AND f.object_evidence_reference::text=f.binding_json#>>'{object,objectEvidenceReference}'
 AND f.provider_object_version::text=f.binding_json#>>'{object,providerObjectVersion}'
 AND f.bucket=f.binding_json#>>'{object,bucket}' AND f.key=f.binding_json#>>'{object,key}'
 AND f.version_id=f.binding_json#>>'{object,versionId}' AND f.etag=f.binding_json#>>'{object,etag}'
 AND s.upload_session_id::text=s.snapshot_json->>'uploadSessionId' AND s.actor_id::text=s.snapshot_json->>'actorReference'
 AND s.version=(s.snapshot_json->>'version')::bigint AND s.state=s.snapshot_json->>'state' AND s.expires_at=(s.snapshot_json->>'expiresAt')::timestamptz
 AND v.asset_id=f.asset_id AND v.upload_session_id=f.upload_session_id
 AND v.asset_version_id::text=v.snapshot_json->>'assetVersionId' AND v.asset_id::text=v.snapshot_json->>'assetId'
 AND v.version=(v.snapshot_json->>'version')::bigint AND v.created_at=(v.snapshot_json->>'createdAt')::timestamptz
 AND a.asset_id::text=a.snapshot_json->>'assetId' AND a.version=(a.snapshot_json->>'version')::bigint
 AND a.current_version_id::text IS NOT DISTINCT FROM a.snapshot_json->>'currentVersionReference') IS TRUE coherent
 FROM bop_media.finalized_object_binding f
 JOIN bop_media.upload_object_binding u ON u.upload_session_id=f.upload_session_id
 JOIN bop_media.operation_record fo ON fo.operation_id=f.operation_id
 JOIN bop_media.operation_record co ON co.operation_id=u.operation_id
 JOIN bop_media.upload_session s ON s.upload_session_id=f.upload_session_id
 JOIN bop_media.asset_version v ON v.asset_version_id=f.asset_version_id
 JOIN bop_media.asset a ON a.asset_id=f.asset_id
 WHERE f.tenant_id=$1 AND f.brand_id=$2 AND f.store_id IS NOT DISTINCT FROM $3 AND f.asset_version_id=$4 LIMIT 2`;

/** Private reconstruction only. The caller must hold actual System permission,
 * original deadline and transaction guards; this neither acquires authority nor
 * treats scan JSON as trusted admission. Current Asset CAS is checked separately. */
export async function loadMediaImageProcessingSource(
  tx: MediaPersistenceTransaction,
  configValue: S3QuarantineImageConfig,
  sourceAssetVersionReference: string,
  scanEvent: unknown,
): Promise<{ readonly source: S3QuarantineImageReadInput; readonly sourceBindingDigest: string }> {
  try {
    const config = parseS3QuarantineImageConfig(configValue),
      reference = parseAssetVersionReference(sourceAssetVersionReference),
      event = copyMediaUploadStorageValue(scanEvent);
    const query = tx.query;
    if (typeof query !== "function") return fail();
    const row = one(
      await query.call(tx, sourceSql, [
        config.tenantReference,
        config.scope.brandReference,
        config.scope.storeReference,
        reference,
      ]),
    );
    if (tx.query !== query || row.coherent !== true) return fail();
    const create = parseMediaUploadStorageCommand(row.create_command),
      final = parseMediaUploadStorageCommand(row.final_command);
    if (
      create.action !== "CreateUpload" ||
      final.action !== "FinalizeAsset" ||
      create.tenantReference !== config.tenantReference ||
      final.tenantReference !== config.tenantReference ||
      !equal(create.scope, config.scope) ||
      !equal(final.scope, config.scope) ||
      create.actorReference !== final.actorReference ||
      final.input.assetVersion.assetVersionId !== reference ||
      create.input.idempotencyKey === final.input.idempotencyKey ||
      row.create_intent_digest !== mediaUploadStorageIntentDigest(create) ||
      row.final_intent_digest !== mediaUploadStorageIntentDigest(final) ||
      !equal(row.create_result, mediaUploadStorageResult(create)) ||
      !equal(row.final_result, mediaUploadStorageResult(final)) ||
      !equal(
        { ...create.input.session, state: "Finalized", version: 2 },
        final.input.closedSession,
      ) ||
      !equal(row.session, final.input.closedSession) ||
      !equal(row.asset_version, final.input.assetVersion)
    )
      return fail();
    const currentAsset = createMediaAsset(row.current_asset as MediaAsset);
    if (!equal({ ...currentAsset, version: 1, currentVersionReference: null }, final.input.asset))
      return fail();
    const upload = uploadBinding(row.upload_binding, create, config),
      binding = finalBinding(row.final_binding, final, upload),
      sourceBindingDigest = digest(binding),
      createdAt = parseMediaInstant(row.create_recorded_at),
      finalizedAt = parseMediaInstant(row.final_recorded_at);
    if (
      row.upload_digest !== digest(upload) ||
      row.final_digest !== sourceBindingDigest ||
      createdAt < create.input.session.createdAt ||
      createdAt >= create.input.session.expiresAt ||
      finalizedAt < createdAt ||
      finalizedAt < final.input.assetVersion.createdAt ||
      finalizedAt < binding.observedAt ||
      finalizedAt >= final.input.closedSession.expiresAt
    )
      return fail();
    parseS3QuarantineImageScanEvent(event, config, binding.object);
    return Object.freeze({
      source: Object.freeze({
        tenantReference: config.tenantReference,
        session: final.input.closedSession,
        asset: final.input.asset,
        assetVersion: final.input.assetVersion,
        object: binding.object,
        scanEvent: event,
      }),
      sourceBindingDigest,
    });
  } catch {
    return fail();
  }
}

/** Owning exact-object lookup for an already authenticated scan delivery. The
 * Worker never supplies a trusted AssetVersion ID and never queries Media SQL.
 * Event JSON validation here binds content only; it does not authenticate SQS. */
export async function resolveMediaImageProcessingSource(
  tx: MediaPersistenceTransaction,
  configValue: S3QuarantineImageConfig,
  scanEvent: unknown,
): Promise<{ readonly source: S3QuarantineImageReadInput; readonly sourceBindingDigest: string }> {
  try {
    const config = parseS3QuarantineImageConfig(configValue),
      event = copyMediaUploadStorageValue(scanEvent),
      body = closed(event, [
        "version",
        "id",
        "detail-type",
        "source",
        "account",
        "time",
        "region",
        "resources",
        "detail",
      ]),
      detail = closed(body.detail, [
        "schemaVersion",
        "scanStatus",
        "resourceType",
        "s3ObjectDetails",
        "scanResultDetails",
      ]),
      raw = closed(detail.s3ObjectDetails, [
        "bucketName",
        "objectKey",
        "eTag",
        "versionId",
        "s3Throttled",
      ]);
    if (
      raw.bucketName !== config.bucket ||
      typeof raw.objectKey !== "string" ||
      !raw.objectKey.startsWith(config.quarantinePrefix) ||
      !/^[a-f0-9]{64}$/u.test(raw.objectKey.slice(config.quarantinePrefix.length)) ||
      typeof raw.versionId !== "string" ||
      !/^[\x21-\x7e]{1,1024}$/u.test(raw.versionId) ||
      raw.versionId === "null" ||
      typeof raw.eTag !== "string" ||
      !/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/u.test(raw.eTag)
    )
      return fail();
    const object = Object.freeze({
      bucket: config.bucket,
      key: raw.objectKey,
      versionId: raw.versionId,
      etag: raw.eTag,
    });
    parseS3QuarantineImageScanEvent(event, config, object);
    const query = tx.query,
      result = await query.call(
        tx,
        `SELECT asset_version_id::text reference,
      (binding_json->'object'->>'bucket'=bucket AND binding_json->'object'->>'key'=key
       AND binding_json->'object'->>'versionId'=version_id AND binding_json->'object'->>'etag'=etag) IS TRUE coherent
      FROM bop_media.finalized_object_binding WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3
       AND bucket=$4 AND key=$5 AND version_id=$6 AND etag=$7 LIMIT 2`,
        [
          config.tenantReference,
          config.scope.brandReference,
          config.scope.storeReference,
          object.bucket,
          object.key,
          object.versionId,
          object.etag,
        ],
      );
    if (tx.query !== query) return fail();
    const d = Object.getOwnPropertyDescriptor(result, "rows");
    if (!d || !("value" in d)) return fail();
    const rows = copyMediaUploadStorageValue(d.value);
    if (!Array.isArray(rows) || rows.length !== 1) return fail();
    const row = closed(rows[0], ["reference", "coherent"]);
    if (row.coherent !== true) return fail();
    const loaded = await loadMediaImageProcessingSource(
      tx,
      config,
      parseAssetVersionReference(row.reference),
      event,
    );
    if (
      !equal(
        {
          bucket: loaded.source.object.bucket,
          key: loaded.source.object.key,
          versionId: loaded.source.object.versionId,
          etag: loaded.source.object.etag,
        },
        object,
      )
    )
      return fail();
    return loaded;
  } catch {
    return fail();
  }
}
