import {
  buildMediaEditorReadSnapshot,
  mediaEditorReadFields,
  MediaEditorReadError,
  parseMediaEditorReadRequest,
  type MediaEditorReadRequest,
  type MediaEditorReadSnapshot,
  type MediaEditorReferenceResult,
} from "../../contracts/media-editor-read.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createMediaAsset,
  createMediaAssetVersion,
  createMediaScope,
  parseAssetVersionReference,
  parseMediaChecksum,
  parseMediaInstant,
  parseMediaReferenceId,
  parseMediaVersion,
  parseObjectEvidenceReference,
  type MediaAsset,
  type MediaAssetVersion,
  type MediaScope,
} from "../../contracts/media.js";
import { copyMediaUploadStorageValue } from "../../contracts/media-upload-storage.js";
import { parseMediaImageScanAdmission } from "../../contracts/media-image-scan-admission.js";
import {
  buildMediaOptionSetPublicationReadSnapshot,
  parseMediaOptionSetPublicationReadRequest,
  type MediaOptionSetPublicationReadRequest,
  type MediaOptionSetPublicationReadSnapshot,
  buildMediaPublicationReadSnapshot,
  mediaPublicationReadFields,
  MediaPublicationReadError,
  parseMediaPublicationReadRequest,
  type MediaPublicationReadRequest,
  type MediaPublicationReadSnapshot,
  type MediaPublicationReference,
  type MediaPublicationReferenceResult,
} from "../../contracts/media-publication-read.js";
import {
  mediaImagePromotionPlanDigest,
  parseMediaImagePromotionPlan,
  parseMediaImagePromotionResult,
} from "../processing/media-image-promotion.js";
import { parseS3QuarantineImageConfig } from "../provider/s3-quarantine-image-source.js";
import { loadMediaImageProcessingSource } from "./media-image-processing-source.js";
import type { MediaPersistenceTransaction } from "./media-upload-store.js";

export interface MediaPublicationReadAuthorityInput {
  readonly request: MediaPublicationReadRequest;
  readonly action: "media.asset.access";
  readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ";
  readonly requiredFields: typeof mediaPublicationReadFields;
}
export interface MediaPublicationReadSourceOptions {
  readonly tenantReference: string;
  readonly scope: MediaScope;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly clock: { now(): string };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MediaPersistenceTransaction,
      input: MediaPublicationReadAuthorityInput,
    ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
  };
  readonly registerBeforeCommit: (
    tx: MediaPersistenceTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
const fail = (): never => {
  throw new MediaPublicationReadError();
};
const equal = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
const digest = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[key] = d.value;
  }
  return r;
}
function rows(value: unknown, maximum: number): readonly unknown[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (!d?.enumerable || !("value" in d) || !Array.isArray(d.value) || d.value.length > maximum)
    return fail();
  // Bound each independent SQL payload instead of combining unrelated immutable
  // record budgets into the small generic metadata capture budget.
  if (
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return fail();
  return Object.freeze(
    Array.from({ length: d.value.length }, (_, n) => {
      const item = Object.getOwnPropertyDescriptor(d.value, String(n));
      if (!item?.enumerable || !("value" in item)) return fail();
      return copyMediaUploadStorageValue(item.value);
    }),
  );
}
const pinSql = `SELECT a.snapshot_json asset,v.snapshot_json version,
 (a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id IS NOT DISTINCT FROM $3
 AND v.tenant_id=a.tenant_id AND v.brand_id=a.brand_id AND v.store_id IS NOT DISTINCT FROM a.store_id
 AND a.asset_id=$4 AND v.asset_id=a.asset_id AND v.asset_version_id=$5
 AND a.asset_id::text=a.snapshot_json->>'assetId' AND a.version=(a.snapshot_json->>'version')::bigint
 AND a.current_version_id::text IS NOT DISTINCT FROM a.snapshot_json->>'currentVersionReference'
 AND v.asset_id::text=v.snapshot_json->>'assetId' AND v.asset_version_id::text=v.snapshot_json->>'assetVersionId'
 AND v.version=(v.snapshot_json->>'version')::bigint AND v.created_at=(v.snapshot_json->>'createdAt')::timestamptz) IS TRUE coherent,
 i.intent_json intent,i.intent_digest,i.plan_digest,c.completion_json completion,c.completion_digest,
 c.asset_snapshot_json completed_asset,c.new_version_json completed_version,
 to_char(c.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') completed_at,
 u.binding_json#>'{config}' source_config,ad.snapshot_json admission,ad.digest admission_digest,
 (i.tenant_id=v.tenant_id AND i.brand_id=v.brand_id AND i.store_id IS NOT DISTINCT FROM v.store_id
 AND i.asset_id=a.asset_id AND i.target_asset_version_id=v.asset_version_id
 AND i.operation_id::text=i.intent_json->>'operationReference' AND i.system_actor_id::text=i.intent_json->>'systemActorReference'
 AND i.source_asset_version_id::text=i.intent_json#>>'{plan,sourceAssetVersionReference}'
 AND i.target_asset_version_id::text=i.intent_json#>>'{plan,targetAssetVersionReference}'
 AND i.expected_asset_version=(i.intent_json#>>'{plan,expectedAssetVersion}')::bigint
 AND i.source_binding_digest=i.intent_json->>'sourceBindingDigest' AND i.scan_event_id=i.intent_json#>>'{source,scanEvent,id}'
 AND i.audit_id::text=i.intent_json->>'auditId' AND i.recorded_at=(i.intent_json->>'createdAt')::timestamptz
 AND c.tenant_id=i.tenant_id AND c.brand_id=i.brand_id AND c.store_id IS NOT DISTINCT FROM i.store_id
 AND c.system_actor_id=i.system_actor_id AND c.asset_id=i.asset_id AND c.source_asset_version_id=i.source_asset_version_id
 AND c.target_asset_version_id=i.target_asset_version_id AND u.tenant_id=v.tenant_id AND u.brand_id=v.brand_id
 AND u.store_id IS NOT DISTINCT FROM v.store_id AND ad.admission_id=i.scan_admission_id
 AND ad.admission_id::text=i.intent_json->>'admissionReference' AND ad.tenant_id=i.tenant_id AND ad.brand_id=i.brand_id
 AND ad.store_id IS NOT DISTINCT FROM i.store_id AND ad.workload_id=i.system_actor_id
 AND ad.source_asset_version_id=i.source_asset_version_id AND ad.source_binding_digest=i.source_binding_digest
 AND ad.event_id=i.scan_event_id AND ad.digest=ad.snapshot_json->>'digest'
 AND ad.admission_id::text=ad.snapshot_json->>'admissionReference' AND ad.tenant_id::text=ad.snapshot_json->>'tenantReference'
 AND ad.brand_id::text=ad.snapshot_json#>>'{scope,brandReference}' AND ad.store_id::text IS NOT DISTINCT FROM ad.snapshot_json#>>'{scope,storeReference}'
 AND ad.workload_id::text=ad.snapshot_json->>'workloadReference' AND ad.source_asset_version_id::text=ad.snapshot_json->>'sourceAssetVersionReference'
 AND ad.source_binding_digest=ad.snapshot_json->>'sourceBindingDigest' AND ad.event_digest=ad.snapshot_json->>'scanEventDigest'
 AND ad.deployment_config_digest=ad.snapshot_json->>'deploymentConfigurationDigest' AND ad.quarantine_config_digest=ad.snapshot_json->>'quarantineConfigurationDigest'
 AND ad.provider_account=ad.snapshot_json->>'providerAccount' AND ad.region=ad.snapshot_json->>'region'
 AND ad.protection_plan_arn=ad.snapshot_json->>'protectionPlanArn' AND ad.event_id=ad.snapshot_json->>'eventId'
 AND ad.bucket=ad.snapshot_json#>>'{object,bucket}' AND ad.key=ad.snapshot_json#>>'{object,key}'
 AND ad.version_id=ad.snapshot_json#>>'{object,versionId}' AND ad.etag=ad.snapshot_json#>>'{object,etag}'
 AND ad.audit_id::text=ad.snapshot_json->>'auditReference' AND ad.correlation_id::text=ad.snapshot_json->>'correlationId'
 AND ad.admitted_at=(ad.snapshot_json->>'admittedAt')::timestamptz) IS TRUE provenance_coherent
 FROM bop_media.asset_version v JOIN bop_media.asset a ON a.asset_id=v.asset_id
 LEFT JOIN bop_media.image_processing_intent i ON i.target_asset_version_id=v.asset_version_id
 LEFT JOIN bop_media.image_processing_completion c ON c.operation_id=i.operation_id
 LEFT JOIN bop_media.upload_object_binding u ON u.upload_session_id=v.upload_session_id
 LEFT JOIN bop_media.image_scan_admission ad ON ad.admission_id=i.scan_admission_id
 WHERE a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id IS NOT DISTINCT FROM $3 AND a.asset_id=$4 AND v.asset_version_id=$5 LIMIT 2`;

export interface MediaEditorReadAuthorityInput {
  readonly request: MediaEditorReadRequest;
  readonly action: "media.asset.access";
  readonly purposeCode: "CATALOG_PRODUCT_EDITOR_MEDIA_READ";
  readonly requiredFields: typeof mediaEditorReadFields;
}
export interface MediaOptionSetPublicationReadAuthorityInput {
  readonly request: MediaOptionSetPublicationReadRequest;
  readonly action: "media.asset.access";
  readonly purposeCode: "CATALOG_OPTION_SET_PUBLICATION_MEDIA_READ";
  readonly requiredFields: typeof mediaPublicationReadFields;
}
export interface MediaOptionSetPublicationReadSourceOptions extends Omit<
  MediaPublicationReadSourceOptions,
  "actorKind" | "authority"
> {
  readonly actorKind: "User";
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MediaPersistenceTransaction,
      input: MediaOptionSetPublicationReadAuthorityInput,
    ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
  };
}
export interface MediaEditorReadSourceOptions extends Omit<
  MediaPublicationReadSourceOptions,
  "actorKind" | "authority"
> {
  readonly actorKind: "User";
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MediaPersistenceTransaction,
      input: MediaEditorReadAuthorityInput,
    ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
  };
}
type ReadRequest =
  MediaPublicationReadRequest | MediaEditorReadRequest | MediaOptionSetPublicationReadRequest;
type ReadFact = MediaPublicationReferenceResult | MediaEditorReferenceResult;
interface ReadSourceOptions<
  R extends ReadRequest,
  P extends string,
  F extends readonly string[],
> extends Omit<MediaPublicationReadSourceOptions, "authority"> {
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: MediaPersistenceTransaction,
      input: {
        readonly request: R;
        readonly action: "media.asset.access";
        readonly purposeCode: P;
        readonly requiredFields: F;
      },
    ): Promise<{ readonly observedAt: string; readonly validUntil: string }>;
  };
}
/** Fixed entry points share only owning SQL and lease mechanics. Neither entry
 * adapts its command into the other protocol or grants reference eligibility. */
export function createPostgresMediaPublicationReadSource(
  options: MediaPublicationReadSourceOptions,
) {
  return createMediaReadSourceKernel<
    MediaPublicationReadRequest,
    "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ",
    typeof mediaPublicationReadFields,
    MediaPublicationReadSnapshot
  >(options, {
    editor: false,
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_MEDIA_READ" as const,
    requiredFields: mediaPublicationReadFields,
    parse: parseMediaPublicationReadRequest,
    fail,
    build(input) {
      const references = input.references.map((value) =>
        value.status === "Recorded" ? fail() : value,
      );
      return buildMediaPublicationReadSnapshot({ ...input, references });
    },
  });
}
export function createPostgresMediaEditorReadSource(options: MediaEditorReadSourceOptions) {
  const unavailable = (): never => {
    throw new MediaEditorReadError();
  };
  return createMediaReadSourceKernel<
    MediaEditorReadRequest,
    "CATALOG_PRODUCT_EDITOR_MEDIA_READ",
    typeof mediaEditorReadFields,
    MediaEditorReadSnapshot
  >(options, {
    editor: true,
    purposeCode: "CATALOG_PRODUCT_EDITOR_MEDIA_READ" as const,
    requiredFields: mediaEditorReadFields,
    parse: parseMediaEditorReadRequest,
    fail: unavailable,
    build(input) {
      const references = input.references.map((value): MediaEditorReferenceResult => {
        if (value.status === "Unavailable") return unavailable();
        if (value.status === "Recorded") return value;
        return Object.freeze({
          mediaReference: value.mediaReference,
          assetReference: value.assetReference,
          assetVersionReference: value.assetVersionReference,
          cropReference: value.cropReference,
          focusReference: value.focusReference,
          status: "Recorded",
          asset: value.asset,
          assetVersion: value.assetVersion,
          processingProvenanceDigest: value.provenanceDigest,
        });
      });
      return buildMediaEditorReadSnapshot({ ...input, references });
    },
  });
}
export function createPostgresMediaOptionSetPublicationReadSource(
  options: MediaOptionSetPublicationReadSourceOptions,
) {
  return createMediaReadSourceKernel<
    MediaOptionSetPublicationReadRequest,
    "CATALOG_OPTION_SET_PUBLICATION_MEDIA_READ",
    typeof mediaPublicationReadFields,
    MediaOptionSetPublicationReadSnapshot
  >(options, {
    editor: false,
    purposeCode: "CATALOG_OPTION_SET_PUBLICATION_MEDIA_READ",
    requiredFields: mediaPublicationReadFields,
    parse: parseMediaOptionSetPublicationReadRequest,
    fail,
    build(input) {
      const references = input.references.map((value) =>
        value.status === "Recorded" ? fail() : value,
      );
      return buildMediaOptionSetPublicationReadSnapshot({ ...input, references });
    },
  });
}
function createMediaReadSourceKernel<
  R extends ReadRequest,
  P extends string,
  F extends readonly string[],
  S,
>(
  options: ReadSourceOptions<R, P, F>,
  protocol: {
    readonly editor: boolean;
    readonly purposeCode: P;
    readonly requiredFields: F;
    readonly parse: (value: unknown) => R;
    readonly fail: () => never;
    readonly build: (input: {
      request: R;
      references: readonly ReadFact[];
      observedAt: string;
      validUntil: string;
    }) => S;
  },
) {
  const fail = protocol.fail;
  try {
    const r = closed(options, [
        "tenantReference",
        "scope",
        "actorReference",
        "actorKind",
        "clock",
        "authority",
        "registerBeforeCommit",
      ]),
      tenantReference = parseMediaReferenceId(r.tenantReference),
      scope = createMediaScope(copyMediaUploadStorageValue(r.scope) as MediaScope),
      actorReference = parseMediaReferenceId(r.actorReference),
      actorKind = r.actorKind,
      c = closed(r.clock, ["now"]),
      a = closed(r.authority, ["holdUntilTransactionCompletes"]);
    if (
      (actorKind !== "User" && actorKind !== "System") ||
      (protocol.editor && actorKind !== "User") ||
      typeof c.now !== "function" ||
      typeof a.holdUntilTransactionCompletes !== "function" ||
      typeof r.registerBeforeCommit !== "function"
    )
      return fail();
    const now = (c.now as () => string).bind(r.clock),
      hold = (
        a.holdUntilTransactionCompletes as ReadSourceOptions<
          R,
          P,
          F
        >["authority"]["holdUntilTransactionCompletes"]
      ).bind(r.authority),
      register = (
        r.registerBeforeCommit as MediaPublicationReadSourceOptions["registerBeforeCommit"]
      ).bind(options),
      active = new WeakSet<object>(),
      failed = new WeakSet<object>();
    return Object.freeze({
      async withCurrentReferences<T>(
        tx: MediaPersistenceTransaction,
        value: R,
        work: (snapshot: S, actualTx: MediaPersistenceTransaction) => Promise<T>,
      ): Promise<T> {
        let request: R | undefined, entryAt: string | undefined;
        try {
          request = protocol.parse(value);
          entryAt = parseMediaInstant(now());
        } catch {
          /* Install a rejecting guard before surfacing invalid input. */
        }
        if (!tx || typeof tx !== "object") return fail();
        const poison = (): never => {
          failed.add(tx);
          return fail();
        };
        if (active.has(tx) || failed.has(tx)) return poison();
        active.add(tx);
        const q = Object.getOwnPropertyDescriptor(tx, "query");
        if (!q || !("value" in q) || typeof q.value !== "function") return poison();
        const originalQuery: MediaPersistenceTransaction["query"] = q.value,
          raw = originalQuery.bind(tx);
        let latest = entryAt ?? "",
          deadline = request?.validUntil ?? "",
          ready = false,
          inCallback = false,
          pending = 0,
          asyncCalls = 0,
          asyncComplete = false,
          finalCalls = 0;
        const check = () => {
          try {
            const d = Object.getOwnPropertyDescriptor(tx, "query"),
              at = parseMediaInstant(now());
            if (
              failed.has(tx) ||
              !d ||
              !("value" in d) ||
              d.value !== originalQuery ||
              !deadline ||
              at < latest ||
              at >= deadline
            )
              return poison();
            latest = at;
            return at;
          } catch {
            return poison();
          }
        };
        const query: MediaPersistenceTransaction["query"] = async <Row>(
          sql: string,
          values: readonly unknown[],
        ) => {
          check();
          pending++;
          try {
            const result = await raw<Row>(sql, values);
            check();
            return result;
          } catch {
            return poison();
          } finally {
            pending--;
          }
        };
        const authorize = async () => {
          if (!request) return poison();
          check();
          const lease = closed(
              copyMediaUploadStorageValue(
                await hold(
                  tx,
                  Object.freeze({
                    request,
                    action: "media.asset.access",
                    purposeCode: protocol.purposeCode,
                    requiredFields: protocol.requiredFields,
                  }),
                ),
              ),
              ["observedAt", "validUntil"],
            ),
            until = parseMediaInstant(lease.validUntil);
          if (lease.observedAt !== request.observedAt || until > deadline || until <= check())
            return poison();
          deadline = until;
          check();
        };
        try {
          if (
            (await register(
              tx,
              async () => {
                try {
                  if (++asyncCalls !== 1 || !ready || inCallback || pending) return poison();
                  check();
                  await authorize();
                  check();
                  asyncComplete = true;
                } catch {
                  return poison();
                }
              },
              () => {
                if (
                  ++finalCalls !== 1 ||
                  asyncCalls !== 1 ||
                  !asyncComplete ||
                  !ready ||
                  inCallback ||
                  pending
                )
                  return poison();
                check();
              },
            )) !== undefined
          )
            return poison();
          if (
            !request ||
            !entryAt ||
            request.observedAt > entryAt ||
            request.tenantReference !== tenantReference ||
            !equal(request.scope, scope) ||
            request.actorReference !== actorReference ||
            request.actorKind !== actorKind ||
            typeof work !== "function"
          )
            return poison();
          check();
          await authorize();
          const contextRows = rows(
            await query(
              "SELECT current_setting('bop.tenant_id',true) tenant_reference,current_setting('bop.brand_id',true) brand_reference,NULLIF(current_setting('bop.store_id',true),'') store_reference,current_setting('transaction_isolation') isolation",
              [],
            ),
            1,
          );
          if (contextRows.length !== 1) return poison();
          const context = closed(contextRows[0], [
            "tenant_reference",
            "brand_reference",
            "store_reference",
            "isolation",
          ]);
          if (
            context.tenant_reference !== tenantReference ||
            context.brand_reference !== scope.brandReference ||
            context.store_reference !== scope.storeReference ||
            context.isolation !== "read committed"
          )
            return poison();
          const references: ReadFact[] = [],
            cache = new Map<
              string,
              | Omit<
                  Extract<MediaPublicationReferenceResult, { status: "Ready" }>,
                  keyof MediaPublicationReference
                >
              | Omit<MediaEditorReferenceResult, keyof MediaPublicationReference>
              | { status: "Unavailable"; reason: "NotFound" | "NotReady" | "UnsupportedMedia" }
            >();
          for (const reference of request.references) {
            check();
            if (reference.cropReference !== null || reference.focusReference !== null) {
              if (protocol.editor) return poison();
              references.push(
                Object.freeze({
                  ...reference,
                  status: "Unavailable",
                  reason: "UnsupportedAdjustment",
                }),
              );
              continue;
            }
            const key = reference.assetReference + ":" + reference.assetVersionReference;
            let found = cache.get(key);
            if (!found) {
              const values = [
                  tenantReference,
                  scope.brandReference,
                  scope.storeReference,
                  reference.assetReference,
                  reference.assetVersionReference,
                ],
                matches = rows(await query(pinSql, values), 2);
              if (matches.length > 1) return poison();
              if (!matches.length) found = { status: "Unavailable", reason: "NotFound" };
              else {
                const row = closed(matches[0], [
                    "asset",
                    "version",
                    "coherent",
                    "intent",
                    "intent_digest",
                    "plan_digest",
                    "completion",
                    "completion_digest",
                    "completed_asset",
                    "completed_version",
                    "completed_at",
                    "source_config",
                    "admission",
                    "admission_digest",
                    "provenance_coherent",
                  ]),
                  asset = createMediaAsset(row.asset as MediaAsset),
                  version = createMediaAssetVersion(row.version as MediaAssetVersion);
                if (
                  row.coherent !== true ||
                  asset.assetId !== reference.assetReference ||
                  !equal(asset.scope, scope) ||
                  version.assetId !== asset.assetId ||
                  version.assetVersionId !== reference.assetVersionReference ||
                  version.createdAt > check()
                )
                  return poison();
                if (
                  protocol.editor &&
                  (asset.mediaKind !== "Image" ||
                    version.checkState !== "Clean" ||
                    version.readinessState !== "Ready")
                ) {
                  // An owning, scoped pin may remain incomplete in a Draft.
                  // Preserve its actual states rather than synthesizing Ready.
                  found = Object.freeze({
                    status: "Recorded",
                    asset: Object.freeze({
                      assetId: asset.assetId,
                      purpose: asset.purpose,
                      scope: asset.scope,
                      mediaKind: asset.mediaKind,
                      ownerType: asset.ownerType,
                      ownerReference: asset.ownerReference,
                      classification: asset.classification,
                    }),
                    assetVersion: version,
                    processingProvenanceDigest: null,
                  });
                } else if (asset.mediaKind !== "Image")
                  found = { status: "Unavailable", reason: "UnsupportedMedia" };
                else if (version.checkState !== "Clean" || version.readinessState !== "Ready")
                  found = { status: "Unavailable", reason: "NotReady" };
                else {
                  // A claimed Ready version with missing or corrupt provenance is
                  // a source failure, never an ordinary negative reference result.
                  if (row.provenance_coherent !== true) return poison();
                  const intent = closed(row.intent, [
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
                    plan = parseMediaImagePromotionPlan(intent.plan),
                    config = parseS3QuarantineImageConfig(row.source_config),
                    admission = parseMediaImageScanAdmission(row.admission),
                    completedAt = parseMediaInstant(row.completed_at),
                    createdAt = parseMediaInstant(intent.createdAt);
                  parseMediaReferenceId(intent.auditId);
                  parseMediaReferenceId(intent.correlationId);
                  parseMediaReferenceId(intent.systemActorReference);
                  if (
                    intent.profile !== "MEDIA_IMAGE_PROCESSING_INTENT_V1" ||
                    intent.operationReference !== plan.operationReference ||
                    intent.tenantReference !== tenantReference ||
                    !equal(intent.scope, scope) ||
                    plan.tenantReference !== tenantReference ||
                    !equal(plan.scope, scope) ||
                    plan.assetReference !== asset.assetId ||
                    plan.targetAssetVersionReference !== version.assetVersionId ||
                    intent.sourceBindingDigest !== plan.sourceBindingDigest ||
                    row.intent_digest !== digest(intent) ||
                    row.plan_digest !== mediaImagePromotionPlanDigest(plan) ||
                    config.tenantReference !== tenantReference ||
                    !equal(config.scope, scope) ||
                    admission.admissionReference !== intent.admissionReference ||
                    admission.workloadReference !== intent.systemActorReference ||
                    admission.tenantReference !== tenantReference ||
                    !equal(admission.scope, scope) ||
                    row.admission_digest !== admission.digest ||
                    admission.sourceAssetVersionReference !== plan.sourceAssetVersionReference ||
                    admission.sourceBindingDigest !== plan.sourceBindingDigest ||
                    admission.quarantineConfigurationDigest !== digest(config) ||
                    admission.admittedAt > createdAt ||
                    createdAt > completedAt ||
                    completedAt > check()
                  )
                    return poison();
                  const source = closed(intent.source, [
                    "tenantReference",
                    "session",
                    "asset",
                    "assetVersion",
                    "object",
                    "scanEvent",
                  ]);
                  if (
                    !equal(source.object, admission.object) ||
                    !equal(source.scanEvent, admission.scanEvent)
                  )
                    return poison();
                  const loaded = await loadMediaImageProcessingSource(
                    Object.freeze({ query }),
                    config,
                    plan.sourceAssetVersionReference,
                    source.scanEvent,
                  );
                  if (
                    !equal(loaded.source, intent.source) ||
                    loaded.sourceBindingDigest !== plan.sourceBindingDigest
                  )
                    return poison();
                  const result = parseMediaImagePromotionResult(
                      row.completion,
                      plan,
                      loaded.source,
                    ),
                    representative = result.renditions[4];
                  if (
                    !representative ||
                    result.completedAt < createdAt ||
                    result.completedAt > completedAt ||
                    result.sourceEvidence.kmsKeyArn !== config.kmsKeyArn ||
                    row.completion_digest !== digest(result)
                  )
                    return poison();
                  const expectedAsset = createMediaAsset({
                      ...loaded.source.asset,
                      version: parseMediaVersion(plan.expectedAssetVersion + 1),
                      currentVersionReference: parseAssetVersionReference(
                        plan.targetAssetVersionReference,
                      ),
                    }),
                    expectedVersion = createMediaAssetVersion({
                      assetVersionId: parseAssetVersionReference(plan.targetAssetVersionReference),
                      assetId: loaded.source.asset.assetId,
                      version: parseMediaVersion(plan.expectedAssetVersion + 1),
                      objectEvidenceReference: parseObjectEvidenceReference(
                        representative.objectEvidenceReference,
                      ),
                      providerObjectVersion: parseMediaReferenceId(
                        representative.providerObjectVersion,
                      ),
                      byteSize: representative.byteSize,
                      checksum: parseMediaChecksum(representative.checksum),
                      contentType: representative.contentType,
                      checkState: "Clean",
                      readinessState: "Ready",
                      createdAt: completedAt,
                    });
                  if (
                    !equal(row.completed_asset, expectedAsset) ||
                    !equal(row.completed_version, expectedVersion) ||
                    !equal(version, expectedVersion) ||
                    !equal(
                      { ...asset, version: 1, currentVersionReference: null },
                      loaded.source.asset,
                    )
                  )
                    return poison();
                  const renditionRows = rows(
                    await query(
                      `SELECT snapshot_json snapshot,(tenant_id=$1 AND brand_id=$2 AND store_id IS NOT DISTINCT FROM $3
                    AND content_type=snapshot_json->>'contentType' AND width=(snapshot_json->>'width')::integer AND height=(snapshot_json->>'height')::integer
                    AND byte_size=(snapshot_json->>'byteSize')::integer AND checksum=snapshot_json->>'checksum'
                    AND object_evidence_reference::text=snapshot_json->>'objectEvidenceReference' AND provider_object_version::text=snapshot_json->>'providerObjectVersion') IS TRUE coherent
                    FROM bop_media.image_rendition WHERE asset_version_id=$4 ORDER BY width,content_type`,
                      [
                        tenantReference,
                        scope.brandReference,
                        scope.storeReference,
                        version.assetVersionId,
                      ],
                    ),
                    7,
                  );
                  if (
                    renditionRows.length !== 6 ||
                    renditionRows.some((v, index) => {
                      const r = closed(v, ["snapshot", "coherent"]);
                      return r.coherent !== true || !equal(r.snapshot, result.renditions[index]);
                    })
                  )
                    return poison();
                  found = Object.freeze({
                    status: "Ready",
                    reason: "Ready",
                    asset: Object.freeze({
                      assetId: asset.assetId,
                      purpose: asset.purpose,
                      scope: asset.scope,
                      mediaKind: asset.mediaKind,
                      ownerType: asset.ownerType,
                      ownerReference: asset.ownerReference,
                      classification: asset.classification,
                    }),
                    assetVersion: version,
                    renditions: Object.freeze(
                      result.renditions.map((v) =>
                        Object.freeze({
                          contentType: v.contentType,
                          width: v.width,
                          height: v.height,
                          byteSize: v.byteSize,
                          checksum: v.checksum,
                          objectEvidenceReference: v.objectEvidenceReference,
                          providerObjectVersion: v.providerObjectVersion,
                        }),
                      ),
                    ),
                    provenanceDigest: digest({
                      intentDigest: row.intent_digest,
                      completionDigest: row.completion_digest,
                      admissionDigest: admission.digest,
                    }),
                  });
                }
              }
              cache.set(key, found);
            }
            references.push(Object.freeze({ ...reference, ...found }));
          }
          const snapshot = protocol.build({
            request,
            references,
            observedAt: check(),
            validUntil: deadline,
          });
          inCallback = true;
          const result = await work(snapshot, tx);
          inCallback = false;
          check();
          ready = true;
          return result;
        } catch {
          return poison();
        } finally {
          inCallback = false;
          active.delete(tx);
        }
      },
    });
  } catch {
    return fail();
  }
}
