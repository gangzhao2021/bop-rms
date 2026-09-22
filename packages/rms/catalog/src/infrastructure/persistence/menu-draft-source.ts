import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingDigest } from "@bop/publishing";
import { parseMenuAggregate } from "../../contracts/category-menu.js";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const selectDraft = `SELECT jsonb_build_object(
'menuReference',m.menu_id,'brandReference',m.brand_id,'internalCode',m.internal_code,
'aggregateVersion',m.aggregate_version,
'createdAt',to_char(m.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'createdByActorReference',m.created_by_actor_id,
'updatedAt',to_char(m.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'draft',jsonb_build_object(
'versionReference',v.menu_version_id,'status',v.status,'baseMenuReference',v.base_menu_id,
'defaultLocale',v.default_locale,'localizedNames',v.localized_names_json,
'createdAt',to_char(v.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'updatedAt',to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'storeReferences',COALESCE((SELECT jsonb_agg(s.store_id ORDER BY s.store_id)
 FROM rms_catalog.menu_version_store s WHERE s.brand_id=m.brand_id AND s.menu_id=m.menu_id AND s.menu_version_id=v.menu_version_id),'[]'::jsonb),
'channelCodes',COALESCE((SELECT jsonb_agg(c.channel_code ORDER BY c.channel_code)
 FROM rms_catalog.menu_version_channel c WHERE c.brand_id=m.brand_id AND c.menu_id=m.menu_id AND c.menu_version_id=v.menu_version_id),'[]'::jsonb),
'orderTypeCodes',COALESCE((SELECT jsonb_agg(o.order_type_code ORDER BY o.order_type_code)
 FROM rms_catalog.menu_version_order_type o WHERE o.brand_id=m.brand_id AND o.menu_id=m.menu_id AND o.menu_version_id=v.menu_version_id),'[]'::jsonb),
'sections',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'sectionReference',s.menu_section_id,'menuReference',s.menu_id,'brandReference',s.brand_id,
 'internalCode',s.internal_code,'localizedNames',s.localized_names_json,'sortOrder',s.sort_order,
 'categoryReferences',COALESCE((SELECT jsonb_agg(c.category_id ORDER BY c.category_id)
 FROM rms_catalog.menu_section_category c WHERE c.menu_section_id=s.menu_section_id AND c.menu_id=m.menu_id AND c.brand_id=m.brand_id),'[]'::jsonb),
 'placements',COALESCE((SELECT jsonb_agg(jsonb_build_object(
 'placementReference',p.placement_id,'menuReference',p.menu_id,'sectionReference',p.menu_section_id,
 'brandReference',p.brand_id,'sellableReference',p.sku_id,'sellableType',p.sellable_type,
 'presentationRole',p.presentation_role,'sortOrder',p.sort_order,'pinned',p.pinned,
 'localizedNameOverrides',p.localized_name_overrides_json,
 'createdAt',to_char(p.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
 'createdByActorReference',p.created_by_actor_id
 ) ORDER BY p.sort_order,p.placement_id) FROM rms_catalog.sellable_placement p
 WHERE p.menu_section_id=s.menu_section_id AND p.menu_id=m.menu_id AND p.brand_id=m.brand_id),'[]'::jsonb)
 ) ORDER BY s.sort_order,s.menu_section_id) FROM rms_catalog.menu_section s
 WHERE s.menu_version_id=v.menu_version_id AND s.menu_id=m.menu_id AND s.brand_id=m.brand_id),'[]'::jsonb)
)) aggregate,
(m.created_at<=$3::timestamptz AND m.updated_at<=$3::timestamptz
 AND v.created_at<=$3::timestamptz AND v.updated_at<=$3::timestamptz
 AND date_trunc('milliseconds',m.created_at)=m.created_at
 AND date_trunc('milliseconds',m.updated_at)=m.updated_at
 AND date_trunc('milliseconds',v.created_at)=v.created_at
 AND date_trunc('milliseconds',v.updated_at)=v.updated_at
 AND NOT EXISTS(SELECT 1 FROM rms_catalog.sellable_placement p
 JOIN rms_catalog.menu_section s ON s.menu_section_id=p.menu_section_id AND s.menu_id=p.menu_id AND s.brand_id=p.brand_id
 WHERE s.menu_version_id=v.menu_version_id AND p.menu_id=m.menu_id AND p.brand_id=m.brand_id
 AND (p.created_at>$3::timestamptz OR date_trunc('milliseconds',p.created_at)<>p.created_at))) coherent
FROM rms_catalog.menu m JOIN rms_catalog.menu_version v ON v.menu_id=m.menu_id AND v.brand_id=m.brand_id
WHERE m.brand_id=$1 AND m.menu_id=$2 AND v.status='Draft'
FOR SHARE OF m,v`;

/** Complete owner configuration only; not a Published Menu or validation verdict.
 * Bind transactions to the caller's UoW to retain Menu/version locks through use. */
export function createPostgresMenuDraftSource(options: {
  brandReference: string;
  transactions: { run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>): Promise<T> };
  authorize(tx: ProductLifecycleTransaction, menuReference: string): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference);
  return Object.freeze({
    async load(menuReference: string, observedAt: string) {
      const menu = parseCatalogReference(menuReference),
        at = parseCatalogInstant(observedAt);
      return options.transactions.run(async (tx) => {
        const allowed = async () => {
          if (!(await options.authorize(tx, menu)))
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
            [brand],
          );
        };
        try {
          await allowed();
          const result = await tx.query<{ aggregate: unknown; coherent: boolean }>(selectDraft, [
            brand,
            menu,
            at,
          ]);
          await allowed();
          if (result.rows.length === 0) return null;
          const row = result.rows[0];
          if (result.rows.length !== 1 || !row || row.coherent !== true)
            throw new Error("incoherent draft");
          const aggregate = parseMenuAggregate(row.aggregate);
          if (aggregate.brandReference !== brand || aggregate.menuReference !== menu)
            throw new Error("scope mismatch");
          return Object.freeze({
            aggregate,
            configurationDigest: parsePublishingDigest(
              "sha256:" + sha256Hex(canonicalizeRfc8785(aggregate)),
            ),
          });
        } catch (error) {
          if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
            throw error;
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        }
      });
    },
  });
}
