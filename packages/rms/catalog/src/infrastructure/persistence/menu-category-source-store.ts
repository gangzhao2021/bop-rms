import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import {
  buildMenuCategorySourceSnapshot,
  menuCategorySourceFields,
  type MenuCategorySourceSnapshot,
} from "../../contracts/menu-category-source.js";
import type { ProductLifecycleTransaction as Transaction } from "./product-lifecycle-store.js";
import { requireCategoryCurrentReads } from "./category-repository.js";

export interface MenuCategorySourceAuthority {
  /** Mandatory current Tenant/Brand/Actor, purpose/field and Phase lease through
   * outer COMMIT. A synthetic callback is not production authorization. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly purposeCode: "CATALOG_MENU_CATEGORY_SOURCE_READ";
      readonly permission: "catalog.manage";
      readonly capability: "catalog.cat_category_tree";
      readonly requiredFields: typeof menuCategorySourceFields;
      readonly observedAt: string;
    },
  ): Promise<void>;
}
const utc = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const collect = (sql: string) =>
  `(SELECT COALESCE(jsonb_agg(row_value),'[]'::jsonb) FROM (${sql} LIMIT 10001) bounded)`;
// All six sets share one PostgreSQL statement snapshot. No caller-authored cursor,
// filter or Store applicability can turn a partial Brand set into known empty.
const select = `SELECT jsonb_build_object('observedAt',${utc("date_trunc('milliseconds',statement_timestamp())")},
'roots',${collect(`SELECT jsonb_build_object('menuReference',m.menu_id,'brandReference',m.brand_id,'aggregateVersion',m.aggregate_version,
'createdAt',${utc("m.created_at")},'updatedAt',${utc("m.updated_at")},'precise',date_trunc('milliseconds',m.created_at)=m.created_at AND date_trunc('milliseconds',m.updated_at)=m.updated_at) row_value FROM rms_catalog.menu m WHERE m.brand_id=$1 ORDER BY m.menu_id`)},
'drafts',${collect(`SELECT jsonb_build_object('menuReference',v.menu_id,'brandReference',v.brand_id,'menuVersionReference',v.menu_version_id,'status',v.status,
'createdAt',${utc("v.created_at")},'updatedAt',${utc("v.updated_at")},'precise',date_trunc('milliseconds',v.created_at)=v.created_at AND date_trunc('milliseconds',v.updated_at)=v.updated_at) row_value FROM rms_catalog.menu_version v WHERE v.brand_id=$1 ORDER BY v.menu_id,v.menu_version_id`)},
'sections',${collect(`SELECT jsonb_build_object('menuReference',s.menu_id,'brandReference',s.brand_id,'menuVersionReference',s.menu_version_id,'sectionReference',s.menu_section_id) row_value FROM rms_catalog.menu_section s WHERE s.brand_id=$1 ORDER BY s.menu_section_id`)},
'bindings',${collect(`SELECT jsonb_build_object('menuReference',b.menu_id,'brandReference',b.brand_id,'sectionReference',b.menu_section_id,'categoryReference',b.category_id) row_value FROM rms_catalog.menu_section_category b WHERE b.brand_id=$1 ORDER BY b.menu_section_id,b.category_id`)},
'reviews',${collect(`SELECT jsonb_build_object('lifecycleReference',c.lifecycle_id,'menuReference',c.menu_id,'brandReference',c.brand_id,'menuVersionReference',c.menu_version_id,'snapshotDigest',c.snapshot_digest,
'createdAt',c.snapshot_json->>'createdAt',
'coherent',jsonb_typeof(c.snapshot_json#>'{content,sections}')='array' AND c.snapshot_json->>'lifecycleReference'=c.lifecycle_id::text AND c.snapshot_json->>'snapshotDigest'=c.snapshot_digest AND c.snapshot_json#>>'{content,brandReference}'=c.brand_id::text AND c.snapshot_json#>>'{content,menuReference}'=c.menu_id::text AND c.snapshot_json#>>'{content,menuVersionReference}'=c.menu_version_id::text,
'sectionReferences',COALESCE((SELECT jsonb_agg(s->'sectionReference') FROM jsonb_array_elements(c.snapshot_json#>'{content,sections}') s),'[]'::jsonb),
'hasCategoryBindings',(c.snapshot_json->'content') ? 'categoryBindings','categoryBindings',c.snapshot_json#>'{content,categoryBindings}') row_value FROM rms_catalog.menu_review_content c WHERE c.brand_id=$1 ORDER BY c.lifecycle_id`)},
'revisions',${collect(`SELECT jsonb_build_object('lifecycleReference',r.lifecycle_id,'menuReference',r.menu_id,'brandReference',r.brand_id,'menuVersionReference',r.menu_version_id,'snapshotDigest',r.snapshot_digest,'state',r.state,'lifecycleVersion',r.lifecycle_version,'revisionCount',r.revision_count,'firstVersion',r.first_version,'coherent',r.coherent AND r.same_menu AND r.same_version AND r.same_digest) row_value FROM (SELECT DISTINCT ON(lifecycle_id) lifecycle_id,menu_id,brand_id,menu_version_id,snapshot_digest,state,lifecycle_version,count(*) OVER(PARTITION BY lifecycle_id) revision_count,min(lifecycle_version) OVER(PARTITION BY lifecycle_id) first_version,
(min(menu_id::text) OVER(PARTITION BY lifecycle_id)=max(menu_id::text) OVER(PARTITION BY lifecycle_id)) same_menu,
(min(menu_version_id::text) OVER(PARTITION BY lifecycle_id)=max(menu_version_id::text) OVER(PARTITION BY lifecycle_id)) same_version,
(min(snapshot_digest) OVER(PARTITION BY lifecycle_id)=max(snapshot_digest) OVER(PARTITION BY lifecycle_id)) same_digest,
bool_and(changed_at<=statement_timestamp() AND date_trunc('milliseconds',changed_at)=changed_at) OVER(PARTITION BY lifecycle_id) coherent FROM rms_catalog.menu_publication_revision WHERE brand_id=$1 ORDER BY lifecycle_id,lifecycle_version DESC) r ORDER BY r.lifecycle_id`)}
) source`;
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Public owning read contract for Category consumers; not current effective Menu,
 * publication approval, live Store activation or a participating-writer barrier.
 * Bind run to the caller's UoW when combining this snapshot with other sources. */
export function createPostgresMenuCategorySourceStore(options: {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: { run<T>(work: (tx: Transaction) => Promise<T>): Promise<T> };
  readonly authority: MenuCategorySourceAuthority;
  readonly clock: { now(): string };
}): { loadSnapshot(): Promise<MenuCategorySourceSnapshot> } {
  const tenant = parseCatalogReference(options.tenantReference),
    brand = parseCatalogReference(options.brandReference),
    actor = parseCatalogReference(options.actorReference);
  return Object.freeze({
    async loadSnapshot() {
      try {
        let selected: MenuCategorySourceSnapshot | undefined;
        let calls = 0;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = async () => {
            await options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                purposeCode: "CATALOG_MENU_CATEGORY_SOURCE_READ",
                permission: "catalog.manage",
                capability: "catalog.cat_category_tree",
                requiredFields: menuCategorySourceFields,
                observedAt: parseCatalogInstant(options.clock.now()),
              }),
            );
          };
          await authorize();
          await requireCategoryCurrentReads(tx);
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
            [brand],
          );
          const result = await tx.query<{ source: unknown }>(select, [brand]);
          const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !Array.isArray(descriptor.value) ||
            descriptor.value.length !== 1
          )
            return fail();
          const row = Object.getOwnPropertyDescriptor(descriptor.value, "0")?.value;
          if (!row || Reflect.ownKeys(row).length !== 1) return fail();
          const source = Object.getOwnPropertyDescriptor(row, "source");
          if (!source?.enumerable || !("value" in source)) return fail();
          const snapshot = buildMenuCategorySourceSnapshot(
            source.value,
            brand,
            options.clock.now(),
          );
          await authorize();
          const completedAt = parseCatalogInstant(options.clock.now());
          if (
            completedAt < snapshot.observedAt ||
            Date.parse(completedAt) - Date.parse(snapshot.observedAt) > 5000
          )
            return fail();
          selected = snapshot;
          return snapshot;
        });
        if (calls !== 1 || result !== selected || !selected) return fail();
        const returnedAt = parseCatalogInstant(options.clock.now());
        if (
          returnedAt < selected.observedAt ||
          Date.parse(returnedAt) - Date.parse(selected.observedAt) > 5000
        )
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
