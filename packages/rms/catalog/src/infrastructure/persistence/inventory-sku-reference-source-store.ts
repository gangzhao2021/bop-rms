import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  buildCatalogInventorySkuReferenceSnapshot,
  parseCatalogInventorySkuReferenceRequest,
  catalogInventorySkuReferenceFields,
  catalogInventorySkuReferencePermissions,
  type CatalogInventorySkuReferenceRequest,
  type CatalogInventorySkuReferenceSnapshot,
} from "../../contracts/inventory-sku-reference-source.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";
export interface CatalogInventorySkuReferenceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: Transaction,
      input: {
        readonly request: CatalogInventorySkuReferenceRequest;
        readonly requiredPermissions: typeof catalogInventorySkuReferencePermissions;
        readonly requiredFields: typeof catalogInventorySkuReferenceFields;
        readonly requiredScope: "FullBrandScope";
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const limit = 1001;
const select = `SELECT jsonb_build_object('observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
 'brandReference',p.brand_id,'productReference',p.product_id,'skuReference',target.sku_id,
 'sourceRevision',(SELECT source_revision::text FROM rms_catalog.product_source_head WHERE brand_id=$1),'productAggregateVersion',p.aggregate_version,
 'configuration',jsonb_build_object('versionReference',v.product_version_id,'categoryCoverage',CASE WHEN v.category_classification_known THEN 'Known' ELSE 'Unavailable' END,'primaryCategoryReference',v.primary_category_id,'taxClassificationReference',v.tax_classification_id,
 'categoryReferences',CASE WHEN v.category_classification_known THEN (SELECT COALESCE(jsonb_agg(category_id),'[]'::jsonb) FROM
 (SELECT c.category_id FROM rms_catalog.product_version_category_assignment c WHERE c.product_version_id=v.product_version_id AND c.product_id=v.product_id AND c.brand_id=v.brand_id ORDER BY c.category_id LIMIT ${limit}) bounded_category) ELSE NULL END,
 'skuReferences',(SELECT COALESCE(jsonb_agg(sku_id),'[]'::jsonb) FROM
 (SELECT s.sku_id FROM rms_catalog.sku s WHERE s.product_version_id=v.product_version_id AND s.product_id=v.product_id AND s.brand_id=v.brand_id ORDER BY s.sku_id LIMIT ${limit}) bounded_sku),
 'bindings',(SELECT COALESCE(jsonb_agg(binding),'[]'::jsonb) FROM
 (SELECT jsonb_build_object('bindingReference',b.binding_id,'optionSetReference',b.option_set_id,'optionSetVersionReference',b.option_set_version_id,
 'enabledOptionReferences',(SELECT COALESCE(jsonb_agg(option_id),'[]'::jsonb) FROM (SELECT o.option_id FROM rms_catalog.product_option_binding_option o WHERE o.binding_id=b.binding_id AND o.product_id=b.product_id AND o.brand_id=b.brand_id ORDER BY o.option_id LIMIT ${limit}) bounded_option),
 'includedSkuReferences',(SELECT COALESCE(jsonb_agg(sku_id),'[]'::jsonb) FROM (SELECT s.sku_id FROM rms_catalog.product_option_binding_sku_scope s WHERE s.binding_id=b.binding_id AND s.product_id=b.product_id AND s.brand_id=b.brand_id AND s.scope_kind='Include' ORDER BY s.sku_id LIMIT ${limit}) bounded_include),
 'excludedSkuReferences',(SELECT COALESCE(jsonb_agg(sku_id),'[]'::jsonb) FROM (SELECT s.sku_id FROM rms_catalog.product_option_binding_sku_scope s WHERE s.binding_id=b.binding_id AND s.product_id=b.product_id AND s.brand_id=b.brand_id AND s.scope_kind='Exclude' ORDER BY s.sku_id LIMIT ${limit}) bounded_exclude),
 'channelCodes',(SELECT COALESCE(jsonb_agg(channel_code),'[]'::jsonb) FROM (SELECT c.channel_code FROM rms_catalog.product_option_binding_channel c WHERE c.binding_id=b.binding_id AND c.product_id=b.product_id AND c.brand_id=b.brand_id ORDER BY c.channel_code LIMIT ${limit}) bounded_channel)) binding
 FROM rms_catalog.product_option_binding b WHERE b.product_version_id=v.product_version_id AND b.product_id=v.product_id AND b.brand_id=v.brand_id ORDER BY b.binding_id LIMIT ${limit}) bounded_binding)),
 'precise',date_trunc('milliseconds',p.created_at)=p.created_at AND date_trunc('milliseconds',p.updated_at)=p.updated_at AND p.created_at<=p.updated_at AND p.updated_at<=statement_timestamp()
 AND date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at AND v.created_at<=v.updated_at AND v.updated_at<=statement_timestamp()
 AND NOT EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=v.brand_id AND s.product_id=v.product_id AND s.product_version_id=v.product_version_id AND (date_trunc('milliseconds',s.created_at)<>s.created_at OR s.created_at>statement_timestamp()))) source
 FROM rms_catalog.product p JOIN rms_catalog.product_version v ON v.brand_id=p.brand_id AND v.product_id=p.product_id
 JOIN rms_catalog.sku target ON target.brand_id=v.brand_id AND target.product_id=v.product_id AND target.product_version_id=v.product_version_id AND target.sku_id=$4
 WHERE p.brand_id=$1 AND p.product_id=$2 AND v.product_version_id=$3 AND v.status='Draft' `;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
function source(value: unknown): unknown {
  if (!value || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length !== 1
  )
    return fail();
  const row = Object.getOwnPropertyDescriptor(descriptor.value, "0")?.value;
  if (!row || Object.getPrototypeOf(row) !== Object.prototype || Reflect.ownKeys(row).length !== 1)
    return fail();
  const d = Object.getOwnPropertyDescriptor(row, "source");
  if (!d?.enumerable || !("value" in d)) return fail();
  return d.value;
}
/** Supported owning Product writers are held through caller COMMIT. Bind the runner
 * to the consumer physical RC UoW. Callback must not mutate Catalog or acquire
 * Catalog writer locks after it begins taking Inventory/Audit fences. */
export function createPostgresCatalogInventorySkuReferenceSourceStore(
  options: CatalogInventorySkuReferenceOptions,
) {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: CatalogInventorySkuReferenceRequest,
      work: (snapshot: CatalogInventorySkuReferenceSnapshot) => Promise<T>,
    ): Promise<T> {
      const request = parseCatalogInventorySkuReferenceRequest(input);
      if (
        request.tenantReference !== tenant ||
        request.brandReference !== brand ||
        request.actorReference !== actor
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      try {
        let calls = 0,
          completed: { readonly value: T } | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                request,
                requiredPermissions: catalogInventorySkuReferencePermissions,
                requiredFields: catalogInventorySkuReferenceFields,
                requiredScope: "FullBrandScope",
                observedAt: parseCatalogInstant(options.clock.now()),
              }),
            );
          const bind = () =>
            tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
              [tenant, brand],
            );
          await authorize();
          await requireCategoryCurrentReads(tx);
          await bind();
          await holdProductSourceBarrier(tx, brand);
          const read = () =>
            tx.query(select, [
              brand,
              request.productReference,
              request.productVersionReference,
              request.skuReference,
            ]);
          const snapshot = buildCatalogInventorySkuReferenceSnapshot(
            source(await read()),
            request,
            options.clock.now(),
          );
          await authorize();
          completed = Object.freeze({ value: await work(snapshot) });
          await authorize();
          await bind();
          const current = buildCatalogInventorySkuReferenceSnapshot(
            source(await read()),
            request,
            options.clock.now(),
          );
          if (
            current.digest !== snapshot.digest ||
            Date.parse(parseCatalogInstant(options.clock.now())) - Date.parse(snapshot.observedAt) >
              5000 ||
            parseCatalogInstant(options.clock.now()) < snapshot.observedAt
          )
            return fail();
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
