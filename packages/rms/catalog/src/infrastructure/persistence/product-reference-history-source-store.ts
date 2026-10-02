import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  parseProductLifecycleReviewRequest,
  type ProductLifecycleReviewRequest,
} from "../../contracts/product-lifecycle-review.js";
import {
  buildProductReferenceHistorySourceSnapshot,
  productReferenceHistorySourceFields,
  productReferenceHistoryCurrentSourceFields,
  productReferenceHistorySourceMaximumRows,
  type ProductReferenceHistorySourceSnapshot,
} from "../../contracts/product-reference-history-source.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";
import {
  buildProductVariantIdentityHistory,
  parseProductVariantIdentityHistoryRequest,
  productVariantHistoryFields,
  type ProductVariantIdentityHistoryRequest,
  type ProductVariantIdentityHistorySnapshot,
} from "../../contracts/product-variant-identity-history.js";

export interface ProductReferenceHistorySourceAuthority {
  /** Actual current scope, purpose, fields, fine action and Phase through outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly actorReference: string;
      readonly request: ProductLifecycleReviewRequest;
      readonly purposeCode: "CATALOG_LIFECYCLE_REFERENCE_HISTORY_READ";
      readonly permission: "catalog.manage";
      readonly owningAction: "catalog.product.history.read";
      readonly requiredFields:
        | typeof productReferenceHistorySourceFields
        | typeof productReferenceHistoryCurrentSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const limit = productReferenceHistorySourceMaximumRows + 1;
// Distinct reference configurations keep repeated lifecycle history bounded by configurations, not operations.
const select = `WITH recorded AS (
 SELECT s.result_aggregate_version,s.occurred_at,
 (r.operation_id IS NOT NULL AND (r.action_code IN ('Create','ReplaceDraft','ChangeLifecycle') OR
 (r.action_code='ProductPublication' AND EXISTS(
 SELECT 1 FROM rms_catalog.product_publication_revision revision
 JOIN rms_catalog.product_source_commit receipt ON receipt.operation_id=revision.operation_id AND receipt.brand_id=revision.brand_id AND receipt.product_id=revision.product_id AND receipt.result_aggregate_version=revision.result_aggregate_version AND receipt.occurred_at=revision.occurred_at
 WHERE revision.operation_id=r.operation_id AND revision.brand_id=s.brand_id AND revision.product_id=s.product_id AND revision.result_aggregate_version=s.result_aggregate_version AND revision.occurred_at=s.occurred_at AND revision.intent_digest=r.intent_digest AND
 receipt.event_type=CASE revision.action_code WHEN 'Validate' THEN 'ProductValidationCompleted' WHEN 'SubmitReview' THEN 'ProductReviewSubmitted' WHEN 'Approve' THEN 'ProductVersionApproved' WHEN 'Reject' THEN 'ProductVersionRejected' WHEN 'SchedulePublish' THEN 'ProductVersionPublishScheduled' WHEN 'ReschedulePublish' THEN 'ProductVersionPublishRescheduled' WHEN 'CancelScheduledPublish' THEN 'ProductVersionPublishScheduleCancelled' WHEN 'Supersede' THEN 'ProductVersionSuperseded' ELSE 'ProductVersionPublished' END))) AND r.result_aggregate_version=s.result_aggregate_version AND r.occurred_at=s.occurred_at AND
 s.snapshot_json->>'brandReference'=s.brand_id::text AND s.snapshot_json->>'productReference'=s.product_id::text AND s.snapshot_json->'aggregateVersion'=to_jsonb(s.result_aggregate_version) AND
 s.snapshot_json->>'updatedAt'=${utc("s.occurred_at")} AND s.snapshot_json#>>'{draft,status}'='Draft' AND (s.snapshot_json->'draft') ? 'taxClassificationReference' AND jsonb_typeof(s.snapshot_json#>'{draft,skus}')='array' AND jsonb_typeof(s.snapshot_json#>'{draft,optionBindings}')='array' AND
 date_trunc('milliseconds',s.occurred_at)=s.occurred_at AND s.occurred_at<=statement_timestamp() AND
 NOT EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.snapshot_json#>'{draft,skus}')='array' THEN s.snapshot_json#>'{draft,skus}' ELSE '[]'::jsonb END) sk WHERE sk->>'productReference' IS DISTINCT FROM s.product_id::text OR sk->>'brandReference' IS DISTINCT FROM s.brand_id::text)) coherent,
 jsonb_build_object('versionReference',s.snapshot_json#>'{draft,versionReference}',
 'categoryClassificationKnown',s.snapshot_json#>'{draft,categoryClassification}' IS NOT NULL,
 'categoryReferences',s.snapshot_json#>'{draft,categoryClassification,categoryReferences}',
 'primaryCategoryReference',s.snapshot_json#>'{draft,categoryClassification,primaryCategoryReference}',
 'taxClassificationReference',s.snapshot_json#>'{draft,taxClassificationReference}',
 'skuReferences',(SELECT COALESCE(jsonb_agg(sk->'skuReference' ORDER BY sk->>'skuReference'),'[]'::jsonb) FROM
 (SELECT sk FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.snapshot_json#>'{draft,skus}')='array' THEN s.snapshot_json#>'{draft,skus}' ELSE '[]'::jsonb END) sk ORDER BY sk->>'skuReference' LIMIT ${limit}) bounded_sku),
 'bindings',(SELECT COALESCE(jsonb_agg(binding ORDER BY binding->>'bindingReference'),'[]'::jsonb) FROM
 (SELECT jsonb_build_object('bindingReference',b->'bindingReference','optionSetReference',b->'optionSetReference','optionSetVersionReference',b->'optionSetVersionReference',
 'enabledOptionReferences',b->'enabledOptionReferences','includedSkuReferences',b->'includedSkuReferences','excludedSkuReferences',b->'excludedSkuReferences','channelCodes',b->'channelCodes') binding
 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.snapshot_json#>'{draft,optionBindings}')='array' THEN s.snapshot_json#>'{draft,optionBindings}' ELSE '[]'::jsonb END) b ORDER BY b->>'bindingReference' LIMIT ${limit}) bounded_binding)) configuration
 FROM rms_catalog.product_operation_snapshot s LEFT JOIN rms_catalog.product_operation_record r ON r.operation_id=s.operation_id AND r.brand_id=s.brand_id AND r.product_id=s.product_id
 WHERE s.brand_id=$1 AND s.product_id=$2)
 SELECT jsonb_build_object('observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},'targetExists',true,'recordedAggregateVersion',p.aggregate_version,
 'recordCoverage',(SELECT count(*)=p.aggregate_version AND min(result_aggregate_version)=1 AND max(result_aggregate_version)=p.aggregate_version AND bool_and(coherent IS TRUE) FROM recorded) AND
 (SELECT count(*)=p.aggregate_version FROM rms_catalog.product_operation_record r WHERE r.brand_id=p.brand_id AND r.product_id=p.product_id),
 'configurations',(SELECT COALESCE(jsonb_agg(configuration),'[]'::jsonb) FROM (SELECT DISTINCT configuration FROM recorded ORDER BY configuration LIMIT ${limit}) bounded_configurations)) source
 FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Standalone loads are statement snapshots. Callback reads hold supported owning
 * Product writers through caller COMMIT; neither method supplies lifecycle approval. */
export function createPostgresProductReferenceHistorySourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: ProductReferenceHistorySourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(
    input: ProductLifecycleReviewRequest,
  ): Promise<ProductReferenceHistorySourceSnapshot>;
  withCurrentSnapshot<T>(
    input: ProductLifecycleReviewRequest,
    work: (snapshot: ProductReferenceHistorySourceSnapshot) => Promise<T>,
  ): Promise<T>;
} {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference);
  async function read<T>(
    input: ProductLifecycleReviewRequest,
    work: (snapshot: ProductReferenceHistorySourceSnapshot) => Promise<T>,
    held: boolean,
  ): Promise<T> {
    try {
      const request = parseProductLifecycleReviewRequest(input);
      if (request.brandReference !== brand || request.actorReference !== actorReference)
        return fail();
      let calls = 0,
        selected: ProductReferenceHistorySourceSnapshot | undefined,
        completed: { readonly value: T } | undefined;
      const result = await options.transactions.run(async (tx) => {
        if (++calls !== 1) return fail();
        const authorize = () =>
          options.authority.holdUntilTransactionCompletes(
            tx,
            Object.freeze({
              tenantReference,
              actorReference,
              request,
              purposeCode: "CATALOG_LIFECYCLE_REFERENCE_HISTORY_READ",
              permission: "catalog.manage",
              owningAction: "catalog.product.history.read",
              requiredFields: held
                ? productReferenceHistoryCurrentSourceFields
                : productReferenceHistorySourceFields,
              observedAt: parseCatalogInstant(options.clock.now()),
            }),
          );
        await authorize();
        await requireCategoryCurrentReads(tx);
        await tx.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
          [tenantReference, brand],
        );
        if (held) {
          await holdProductSourceBarrier(tx, brand);
          const target = await tx.query<{ revision: string; intent_matches: boolean }>(
            `SELECT p.aggregate_version::text revision,
               EXISTS(SELECT 1 FROM rms_catalog.product_version v WHERE v.brand_id=p.brand_id AND v.product_id=p.product_id AND v.product_version_id=$3 AND v.status='Draft') AND
               (CASE WHEN $4::uuid IS NULL THEN p.lifecycle ELSE (SELECT s.lifecycle FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id AND s.product_version_id=$3 AND s.sku_id=$4) END)=$5 AND
               (SELECT count(*) FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id AND s.product_version_id=$3 AND s.lifecycle='Active')=$6 AS intent_matches
               FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2`,
            [
              brand,
              request.productReference,
              request.originalProductVersionReference,
              request.skuReference,
              request.beforeLifecycle,
              request.activeSkuCount,
            ],
          );
          const rows = Object.getOwnPropertyDescriptor(target, "rows")?.value;
          if (!Array.isArray(rows) || rows.length !== 1) return fail();
          const row = Object.getOwnPropertyDescriptor(rows, "0")?.value;
          if (
            !row ||
            Reflect.ownKeys(row).length !== 2 ||
            Object.getOwnPropertyDescriptor(row, "revision")?.value !==
              String(request.expectedAggregateVersion) ||
            Object.getOwnPropertyDescriptor(row, "intent_matches")?.value !== true
          )
            return fail();
        }
        const result = await tx.query<{ source: unknown }>(select, [
          brand,
          request.productReference,
        ]);
        const rows = Object.getOwnPropertyDescriptor(result, "rows");
        if (!rows || !("value" in rows) || !Array.isArray(rows.value) || rows.value.length !== 1)
          return fail();
        const row = Object.getOwnPropertyDescriptor(rows.value, "0")?.value;
        if (!row || Reflect.ownKeys(row).length !== 1) return fail();
        const source = Object.getOwnPropertyDescriptor(row, "source");
        if (!source?.enumerable || !("value" in source)) return fail();
        selected = buildProductReferenceHistorySourceSnapshot(
          source.value,
          request,
          options.clock.now(),
        );
        await authorize();
        completed = Object.freeze({ value: await work(selected) });
        if (held) {
          await authorize();
          const at = parseCatalogInstant(options.clock.now());
          if (at < selected.observedAt || Date.parse(at) - Date.parse(selected.observedAt) > 5000)
            return fail();
        }
        return completed;
      });
      if (calls !== 1 || !selected || !completed || result !== completed) return fail();
      if (!held) {
        const at = parseCatalogInstant(options.clock.now());
        if (at < selected.observedAt || Date.parse(at) - Date.parse(selected.observedAt) > 5000)
          return fail();
      }
      return completed.value;
    } catch (error) {
      if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED") throw error;
      return fail();
    }
  }
  return Object.freeze({
    loadSnapshot: (input: ProductLifecycleReviewRequest) =>
      read(input, async (snapshot) => snapshot, false),
    withCurrentSnapshot: <T>(
      input: ProductLifecycleReviewRequest,
      work: (snapshot: ProductReferenceHistorySourceSnapshot) => Promise<T>,
    ) => read(input, work, true),
  });
}

/** Current owner history, held through caller work and its outer COMMIT. This
 * shares the existing history persistence asset and Product source barrier. */
export function createPostgresProductVariantIdentityHistorySource(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: Transaction,
      input: {
        readonly tenantReference: string;
        readonly brandReference: string;
        readonly actorReference: string;
        readonly purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY";
        readonly permission: "catalog.product.history.read";
        readonly request: ProductVariantIdentityHistoryRequest;
        readonly requiredFields: typeof productVariantHistoryFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}) {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brandReference = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference);
  const query = `SELECT jsonb_build_object('aggregateVersion',p.aggregate_version,'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},'history',CASE WHEN
    (SELECT sum(octet_length(snapshot_json::text)) FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 AND product_id=$2)<=8388608 THEN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('aggregate',s.snapshot_json,'operationReference',s.operation_id,'snapshotDigest',c.snapshot_digest,'coherent',
      r.result_aggregate_version=s.result_aggregate_version AND r.occurred_at=s.occurred_at AND c.result_aggregate_version=s.result_aggregate_version AND c.occurred_at=s.occurred_at
      AND s.snapshot_json->'aggregateVersion'=to_jsonb(s.result_aggregate_version) AND s.snapshot_json->>'updatedAt'=${utc("s.occurred_at")}
      AND (SELECT count(*) FROM rms_catalog.product_operation_record o WHERE o.brand_id=p.brand_id AND o.product_id=p.product_id)=p.aggregate_version
      AND (SELECT count(*) FROM rms_catalog.product_source_commit sc WHERE sc.brand_id=p.brand_id AND sc.product_id=p.product_id)=p.aggregate_version)
      ORDER BY s.result_aggregate_version)
    FROM (SELECT * FROM rms_catalog.product_operation_snapshot WHERE brand_id=$1 AND product_id=$2 ORDER BY result_aggregate_version LIMIT 1001) s
    LEFT JOIN rms_catalog.product_operation_record r ON r.operation_id=s.operation_id AND r.brand_id=s.brand_id AND r.product_id=s.product_id
    LEFT JOIN rms_catalog.product_source_commit c ON c.operation_id=s.operation_id AND c.brand_id=s.brand_id AND c.product_id=s.product_id
  ),'[]'::jsonb) ELSE NULL END) source FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2 AND p.aggregate_version=$3`;
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: ProductVariantIdentityHistoryRequest,
      work: (snapshot: ProductVariantIdentityHistorySnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parseProductVariantIdentityHistoryRequest(input);
        let calls = 0,
          completed: { value: T } | undefined;
        const returned = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                brandReference,
                actorReference,
                purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY",
                permission: "catalog.product.history.read",
                request,
                requiredFields: productVariantHistoryFields,
                observedAt: parseCatalogInstant(options.clock.now()),
              }),
            );
          await authorize();
          const isolation = await tx.query<{ isolation: string }>(
            "SELECT current_setting('transaction_isolation') AS isolation",
            [],
          );
          if (isolation.rows.length !== 1 || isolation.rows[0]?.isolation !== "read committed")
            return fail();
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
            [tenantReference, brandReference],
          );
          await holdProductSourceBarrier(tx, brandReference);
          const result = await tx.query<{ source: unknown }>(query, [
            brandReference,
            request.productReference,
            request.expectedAggregateVersion,
          ]);
          if (result.rows.length !== 1) return fail();
          const snapshot = buildProductVariantIdentityHistory(
            result.rows[0]?.source,
            brandReference,
            request,
          );
          const fresh = () => {
            const at = parseCatalogInstant(options.clock.now());
            if (at < snapshot.observedAt || Date.parse(at) - Date.parse(snapshot.observedAt) > 5000)
              return fail();
          };
          await authorize();
          fresh();
          const value = await work(snapshot);
          await authorize();
          fresh();
          completed = Object.freeze({ value });
          return completed;
        });
        if (calls !== 1 || !completed || returned !== completed) return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
