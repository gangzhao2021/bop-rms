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
  buildProductBundleSourceSnapshot,
  productBundleSourceFields,
  productBundleSourceMaximumRows,
  type ProductBundleSourceSnapshot,
} from "../../contracts/product-bundle-source.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";

export interface ProductBundleSourceAuthority {
  /** Actual current scope, purpose, fields, fine action and Phase through outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly actorReference: string;
      readonly request: ProductLifecycleReviewRequest;
      readonly purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ";
      readonly permission: "catalog.manage";
      readonly requiredFields: typeof productBundleSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const limit = productBundleSourceMaximumRows + 1;
// Single statement includes phantom-sensitive membership and all Bundle versions/lifecycle states.
// SQL bounds are checked in the public parser; truncation can never become Complete.
const select = `SELECT jsonb_build_object(
'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
'targetExists',EXISTS(SELECT 1 FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2
 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id AND s.sku_id=$3::uuid))),
'skuReferences',(SELECT COALESCE(jsonb_agg(sku_id ORDER BY sku_id),'[]'::jsonb) FROM
 (SELECT sku_id FROM rms_catalog.sku WHERE brand_id=$1 AND product_id=$2 AND ($3::uuid IS NULL OR sku_id=$3::uuid) ORDER BY sku_id LIMIT ${limit}) s),
'references',(SELECT COALESCE(jsonb_agg(row_value),'[]'::jsonb) FROM
 (SELECT jsonb_build_object('reference',jsonb_build_object(
 'bundleReference',b.bundle_id,'brandReference',b.brand_id,'aggregateVersion',b.aggregate_version,
 'lifecycle',b.lifecycle,'currentVersionReference',b.current_version_id,'updatedAt',${utc("b.updated_at")},
 'bundleVersionReference',v.bundle_version_id,'versionStatus',v.status,'versionUpdatedAt',${utc("v.updated_at")},
 'publishedAt',${utc("v.published_at")},'validationDigest',v.validation_digest,
 'groupReference',g.group_id,'sellableType',c.sellable_type,'sellableReference',c.sellable_id),
 'coherent',b.lifecycle IN ('Draft','Archived') OR EXISTS(SELECT 1 FROM rms_catalog.bundle_version current_version
 WHERE current_version.bundle_version_id=b.current_version_id AND current_version.bundle_id=b.bundle_id AND current_version.brand_id=b.brand_id AND current_version.status='Published'),
 'precise',date_trunc('milliseconds',b.updated_at)=b.updated_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at
 AND (v.published_at IS NULL OR date_trunc('milliseconds',v.published_at)=v.published_at)) row_value
 FROM rms_catalog.bundle_component_sellable c
 JOIN rms_catalog.bundle_component_group g ON g.group_id=c.group_id AND g.bundle_version_id=c.bundle_version_id AND g.bundle_id=c.bundle_id AND g.brand_id=c.brand_id
 JOIN rms_catalog.bundle_version v ON v.bundle_version_id=g.bundle_version_id AND v.bundle_id=g.bundle_id AND v.brand_id=g.brand_id
 JOIN rms_catalog.bundle b ON b.bundle_id=v.bundle_id AND b.brand_id=v.brand_id
 WHERE c.brand_id=$1 AND ((c.sellable_type='Product' AND c.sellable_id=$2) OR (c.sellable_type='Sku' AND
 EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=c.brand_id AND s.product_id=$2 AND s.sku_id=c.sellable_id AND ($3::uuid IS NULL OR s.sku_id=$3::uuid))))
 ORDER BY c.group_id,c.sellable_id LIMIT ${limit}) bounded)) source`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Bind runner to caller UoW when composing. This is not a writer barrier or approval. */
export function createPostgresProductBundleSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: ProductBundleSourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(input: ProductLifecycleReviewRequest): Promise<ProductBundleSourceSnapshot>;
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
          selected: ProductBundleSourceSnapshot | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                actorReference,
                request,
                purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ",
                permission: "catalog.manage",
                requiredFields: productBundleSourceFields,
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
          selected = buildProductBundleSourceSnapshot(source.value, request, options.clock.now());
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
