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
  buildProductAvailabilitySourceSnapshot,
  productAvailabilitySourceFields,
  productAvailabilitySourceMaximumRows,
  type ProductAvailabilitySourceSnapshot,
} from "../../contracts/product-availability-source.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";

export interface ProductAvailabilitySourceAuthority {
  /** Actual current scope, purpose, fields, fine action and Phase through outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly actorReference: string;
      readonly request: ProductLifecycleReviewRequest;
      readonly purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ";
      readonly permission: "catalog.manage";
      readonly requiredFields: typeof productAvailabilitySourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const limit = productAvailabilitySourceMaximumRows + 1;
// Single statement includes phantom-sensitive membership and all relevant rule states.
// SQL bounds are checked in the public parser; truncation can never become Complete.
const select = `SELECT jsonb_build_object(
'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
'targetExists',EXISTS(SELECT 1 FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2
 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id AND s.sku_id=$3::uuid))),
'skuReferences',(SELECT COALESCE(jsonb_agg(sku_id ORDER BY sku_id),'[]'::jsonb) FROM
 (SELECT sku_id FROM rms_catalog.sku WHERE brand_id=$1 AND product_id=$2 AND ($3::uuid IS NULL OR sku_id=$3::uuid) ORDER BY sku_id LIMIT ${limit}) s),
'rules',(SELECT COALESCE(jsonb_agg(row_value),'[]'::jsonb) FROM
 (SELECT jsonb_build_object('rule',jsonb_build_object(
 'ruleReference',r.availability_rule_id,'brandReference',r.brand_id,'sellableType',r.sellable_type,
 'sellableReference',COALESCE(r.product_id,r.sku_id),'storeReference',r.store_id,
 'aggregateVersion',r.aggregate_version,'lifecycle',r.lifecycle,
 'effectiveFrom',${utc("r.effective_from")},'effectiveUntil',${utc("r.effective_until")},'updatedAt',${utc("r.updated_at")}),
 'precise',date_trunc('milliseconds',r.effective_from)=r.effective_from AND
 (r.effective_until IS NULL OR date_trunc('milliseconds',r.effective_until)=r.effective_until) AND date_trunc('milliseconds',r.updated_at)=r.updated_at) row_value
 FROM rms_catalog.availability_rule r WHERE r.brand_id=$1 AND
 ((r.sellable_type='Product' AND r.product_id=$2) OR (r.sellable_type='Sku' AND
 EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=r.brand_id AND s.product_id=$2 AND s.sku_id=r.sku_id AND ($3::uuid IS NULL OR s.sku_id=$3::uuid))))
 ORDER BY r.availability_rule_id LIMIT ${limit}) bounded)) source`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Bind runner to caller UoW when composing. This is not a writer barrier or approval. */
export function createPostgresProductAvailabilitySourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: ProductAvailabilitySourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(input: ProductLifecycleReviewRequest): Promise<ProductAvailabilitySourceSnapshot>;
} {
  const tenantReference = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actorReference = parseCatalogReference(options.actorReference);
  return Object.freeze({
    async loadSnapshot(input) {
      try {
        const request = parseProductLifecycleReviewRequest(input);
        if (request.brandReference !== brand || request.actorReference !== actorReference)
          return fail();
        let calls = 0,
          selected: ProductAvailabilitySourceSnapshot | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                actorReference,
                request,
                purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ",
                permission: "catalog.manage",
                requiredFields: productAvailabilitySourceFields,
                observedAt: parseCatalogInstant(options.clock.now()),
              }),
            );
          await authorize();
          await requireCategoryCurrentReads(tx);
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
            [brand],
          );
          const result = await tx.query<{ source: unknown }>(select, [
            brand,
            request.productReference,
            request.skuReference,
          ]);
          const rows = Object.getOwnPropertyDescriptor(result, "rows");
          if (!rows || !("value" in rows) || !Array.isArray(rows.value) || rows.value.length !== 1)
            return fail();
          const row = Object.getOwnPropertyDescriptor(rows.value, "0")?.value;
          if (!row || Reflect.ownKeys(row).length !== 1) return fail();
          const source = Object.getOwnPropertyDescriptor(row, "source");
          if (!source?.enumerable || !("value" in source)) return fail();
          selected = buildProductAvailabilitySourceSnapshot(
            source.value,
            request,
            options.clock.now(),
          );
          await authorize();
          return selected;
        });
        if (calls !== 1 || !selected || result !== selected) return fail();
        const at = parseCatalogInstant(options.clock.now());
        if (at < selected.observedAt || Date.parse(at) - Date.parse(selected.observedAt) > 5000)
          return fail();
        return selected;
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        return fail();
      }
    },
  });
}
