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
  buildProductPricingBindingSourceSnapshot,
  productPricingBindingSourceFields,
  productPricingBindingCurrentSourceFields,
  productPricingBindingSourceMaximumRows,
  type ProductPricingBindingSourceSnapshot,
} from "../../contracts/product-pricing-binding-source.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";
import { holdProductSourceBarrier } from "./product-source-producer.js";

export interface ProductPricingBindingSourceAuthority {
  /** Actual current scope, purpose, fields, fine action and Phase through outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly actorReference: string;
      readonly request: ProductLifecycleReviewRequest;
      readonly purposeCode: "CATALOG_LIFECYCLE_PRICING_BINDING_SOURCE_READ";
      readonly permission: "catalog.manage";
      readonly requiredFields:
        typeof productPricingBindingSourceFields | typeof productPricingBindingCurrentSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const limit = productPricingBindingSourceMaximumRows + 1;
// Bounded exact current Draft membership; own FK tuples enforce Brand/Product ownership.
const select = `SELECT jsonb_build_object('observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
 'targetExists',EXISTS(SELECT 1 FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2),
 'versionReference',v.product_version_id,'categoryClassificationKnown',v.category_classification_known,'primaryCategoryReference',v.primary_category_id,'taxClassificationReference',v.tax_classification_id,
 'precise',date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at AND v.created_at<=v.updated_at AND v.updated_at<=statement_timestamp(),
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
 FROM rms_catalog.product_option_binding b WHERE b.product_version_id=v.product_version_id AND b.product_id=v.product_id AND b.brand_id=v.brand_id ORDER BY b.binding_id LIMIT ${limit}) bounded_binding)) source
 FROM rms_catalog.product_version v WHERE v.brand_id=$1 AND v.product_id=$2 AND v.product_version_id=$3 AND v.status='Draft'`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Standalone loads are statement snapshots. Callback reads hold supported owning
 * Product writers through caller COMMIT; neither method supplies lifecycle approval. */
export function createPostgresProductPricingBindingSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: ProductPricingBindingSourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(input: ProductLifecycleReviewRequest): Promise<ProductPricingBindingSourceSnapshot>;
  withCurrentSnapshot<T>(
    input: ProductLifecycleReviewRequest,
    work: (snapshot: ProductPricingBindingSourceSnapshot) => Promise<T>,
  ): Promise<T>;
} {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference);
  async function read<T>(
    input: ProductLifecycleReviewRequest,
    work: (snapshot: ProductPricingBindingSourceSnapshot) => Promise<T>,
    held: boolean,
  ): Promise<T> {
    try {
      const request = parseProductLifecycleReviewRequest(input);
      if (request.brandReference !== brand || request.actorReference !== actorReference)
        return fail();
      let calls = 0,
        selected: ProductPricingBindingSourceSnapshot | undefined,
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
              purposeCode: "CATALOG_LIFECYCLE_PRICING_BINDING_SOURCE_READ",
              permission: "catalog.manage",
              requiredFields: held
                ? productPricingBindingCurrentSourceFields
                : productPricingBindingSourceFields,
              observedAt: parseCatalogInstant(options.clock.now()),
            }),
          );
        await authorize();
        await requireCategoryCurrentReads(tx);
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
          [brand],
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
          request.originalProductVersionReference,
        ]);
        const rows = Object.getOwnPropertyDescriptor(result, "rows");
        if (!rows || !("value" in rows) || !Array.isArray(rows.value) || rows.value.length !== 1)
          return fail();
        const row = Object.getOwnPropertyDescriptor(rows.value, "0")?.value;
        if (!row || Reflect.ownKeys(row).length !== 1) return fail();
        const source = Object.getOwnPropertyDescriptor(row, "source");
        if (!source?.enumerable || !("value" in source)) return fail();
        selected = buildProductPricingBindingSourceSnapshot(
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
      work: (snapshot: ProductPricingBindingSourceSnapshot) => Promise<T>,
    ) => read(input, work, true),
  });
}
