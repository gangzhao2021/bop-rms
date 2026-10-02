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
  buildProductMenuSourceSnapshot,
  productMenuSourceFields,
  productMenuSourceMaximumRows,
  type ProductMenuSourceSnapshot,
} from "../../contracts/product-menu-source.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";

export interface ProductMenuSourceAuthority {
  /** Actual current scope, purpose, fields, fine action and Phase through outer COMMIT. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly actorReference: string;
      readonly request: ProductLifecycleReviewRequest;
      readonly purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ";
      readonly permission: "catalog.manage";
      readonly requiredFields: typeof productMenuSourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const limit = productMenuSourceMaximumRows + 1;
// One statement covers target membership and all immutable reviewed snapshots/publication histories.
// SQL bounds are checked in the public parser; truncation can never become Complete.
const array = (expression: string) =>
  `CASE WHEN jsonb_typeof(${expression})='array' THEN ${expression} ELSE '[]'::jsonb END`;
const collect = (sql: string) =>
  `(SELECT COALESCE(jsonb_agg(row_value),'[]'::jsonb) FROM (${sql} LIMIT ${limit}) bounded)`;
const select = `SELECT jsonb_build_object(
'observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
'targetExists',EXISTS(SELECT 1 FROM rms_catalog.product p WHERE p.brand_id=$1 AND p.product_id=$2
 AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id AND s.sku_id=$3::uuid))),
'coverageComplete',NOT EXISTS(SELECT 1 FROM rms_catalog.menu_publication_revision r WHERE r.brand_id=$1 AND NOT EXISTS
 (SELECT 1 FROM rms_catalog.menu_review_content c WHERE c.lifecycle_id=r.lifecycle_id AND c.brand_id=r.brand_id AND c.menu_id=r.menu_id AND c.menu_version_id=r.menu_version_id AND c.snapshot_digest=r.snapshot_digest))
 AND NOT EXISTS(SELECT 1 FROM rms_catalog.menu_publication_release r WHERE r.brand_id=$1 AND NOT EXISTS
 (SELECT 1 FROM rms_catalog.menu_review_content c WHERE c.lifecycle_id=r.lifecycle_id AND c.brand_id=r.brand_id AND c.menu_id=r.menu_id AND c.menu_version_id=r.menu_version_id AND c.snapshot_digest=r.snapshot_digest)),
'skuReferences',(SELECT COALESCE(jsonb_agg(sku_id ORDER BY sku_id),'[]'::jsonb) FROM
 (SELECT sku_id FROM rms_catalog.sku WHERE brand_id=$1 AND product_id=$2 AND ($3::uuid IS NULL OR sku_id=$3::uuid) ORDER BY sku_id LIMIT ${limit}) s),
'productVersionReferences',(SELECT COALESCE(jsonb_agg(product_version_id ORDER BY product_version_id),'[]'::jsonb) FROM
 (SELECT product_version_id FROM rms_catalog.product_version WHERE brand_id=$1 AND product_id=$2 ORDER BY product_version_id LIMIT ${limit}) v),
'reviews',${collect(`SELECT jsonb_build_object('reviewReference',c.lifecycle_id,'brandReference',c.brand_id,'menuReference',c.menu_id,'menuVersionReference',c.menu_version_id,'snapshotDigest',c.snapshot_digest,
'createdAt',c.snapshot_json->>'createdAt',
'coherent',jsonb_typeof(c.snapshot_json#>'{content,sections}')='array' AND NOT EXISTS
 (SELECT 1 FROM jsonb_array_elements(${array("c.snapshot_json#>'{content,sections}'")}) section WHERE jsonb_typeof(section->'sellables') IS DISTINCT FROM 'array'),
'placements',${collect(`SELECT jsonb_build_object('sectionReference',section->'sectionReference','placementReference',placement->'placementReference','skuReference',placement->'sellableReference','productVersionReference',placement->'productVersionReference') row_value
 FROM jsonb_array_elements(${array("c.snapshot_json#>'{content,sections}'")}) section CROSS JOIN LATERAL jsonb_array_elements(${array("section->'sellables'")}) placement`)},
'lifecycle',(SELECT jsonb_build_object('state',r.state,'version',r.lifecycle_version,'changedAt',${utc("r.changed_at")},
 'coherent',r.revision_count=r.lifecycle_version-r.first_version+1 AND r.same_menu AND r.same_version AND r.same_digest AND r.precise)
 FROM (SELECT state,lifecycle_version,changed_at,count(*) OVER() revision_count,min(lifecycle_version) OVER() first_version,
 bool_and(menu_id=c.menu_id) OVER() same_menu,bool_and(menu_version_id=c.menu_version_id) OVER() same_version,bool_and(snapshot_digest=c.snapshot_digest) OVER() same_digest,
 bool_and(changed_at<=statement_timestamp() AND date_trunc('milliseconds',changed_at)=changed_at) OVER() precise
 FROM rms_catalog.menu_publication_revision WHERE brand_id=c.brand_id AND lifecycle_id=c.lifecycle_id ORDER BY lifecycle_version DESC LIMIT 1) r),
'releases',${collect(`SELECT jsonb_build_object('releaseReference',r.release_id,'releaseSequence',r.release_sequence,'releaseKind',r.release_kind,'lifecycleVersion',r.lifecycle_version,'snapshotDigest',r.snapshot_digest,'createdAt',${utc("r.created_at")},
'coherent',r.menu_id=c.menu_id AND r.menu_version_id=c.menu_version_id AND r.snapshot_digest=c.snapshot_digest AND date_trunc('milliseconds',r.created_at)=r.created_at
 AND EXISTS(SELECT 1 FROM rms_catalog.menu_publication_revision revision WHERE revision.lifecycle_id=r.lifecycle_id AND revision.lifecycle_version=r.lifecycle_version
 AND revision.brand_id=r.brand_id AND revision.menu_id=r.menu_id AND revision.menu_version_id=r.menu_version_id AND revision.snapshot_digest=r.snapshot_digest AND revision.state='Published' AND revision.changed_at<=r.created_at)
 AND ((r.release_sequence=1 AND r.previous_release_id IS NULL) OR EXISTS(SELECT 1 FROM rms_catalog.menu_publication_release prior WHERE prior.release_id=r.previous_release_id AND prior.menu_id=r.menu_id AND prior.brand_id=r.brand_id AND prior.release_sequence=r.release_sequence-1 AND prior.created_at<=r.created_at)),
'periods',${collect(`SELECT jsonb_build_object('timingReference',p.timing_version_id,'timeZone',p.time_zone,'effectiveFrom',${utc("p.effective_from")},'effectiveUntil',${utc("p.effective_until")},'periodDigest',p.period_digest,'createdAt',${utc("p.created_at")},
'precise',p.menu_id=r.menu_id AND p.brand_id=r.brand_id AND date_trunc('milliseconds',p.effective_from)=p.effective_from AND
 (p.effective_until IS NULL OR date_trunc('milliseconds',p.effective_until)=p.effective_until) AND date_trunc('milliseconds',p.created_at)=p.created_at) row_value
 FROM rms_catalog.menu_release_effective_period p WHERE p.release_id=r.release_id ORDER BY p.timing_version_id`)}) row_value
 FROM rms_catalog.menu_publication_release r WHERE r.brand_id=c.brand_id AND r.lifecycle_id=c.lifecycle_id ORDER BY r.release_sequence`)}) row_value
 FROM rms_catalog.menu_review_content c WHERE c.brand_id=$1 ORDER BY c.lifecycle_id`)} ) source`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Bind runner to caller UoW when composing. This is not a writer barrier or approval. */
export function createPostgresProductMenuSourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: ProductMenuSourceAuthority;
  readonly clock: { now(): string };
}): {
  loadSnapshot(input: ProductLifecycleReviewRequest): Promise<ProductMenuSourceSnapshot>;
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
          selected: ProductMenuSourceSnapshot | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference,
                actorReference,
                request,
                purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ",
                permission: "catalog.manage",
                requiredFields: productMenuSourceFields,
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
          selected = buildProductMenuSourceSnapshot(source.value, request, options.clock.now());
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
