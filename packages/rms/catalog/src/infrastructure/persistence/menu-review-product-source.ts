import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogLocale,
  parseLocalizedNames,
  parseProductLifecycle,
} from "../../contracts/product.js";
import type { ProductLifecycleTransaction } from "./product-lifecycle-store.js";

const select = `SELECT s.sku_id,s.product_id,s.product_version_id,s.brand_id,
  p.lifecycle AS product_lifecycle,s.lifecycle AS sku_lifecycle,
  v.default_locale,v.localized_names_json AS product_names,s.localized_names_json AS sku_names,
  to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS product_updated_at,
  to_char(v.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS version_updated_at,
  (p.created_at <= $3::timestamptz AND p.updated_at <= $3::timestamptz
   AND v.created_at <= $3::timestamptz AND v.updated_at <= $3::timestamptz
   AND s.created_at <= $3::timestamptz
   AND date_trunc('milliseconds',p.created_at)=p.created_at
   AND date_trunc('milliseconds',p.updated_at)=p.updated_at
   AND date_trunc('milliseconds',v.created_at)=v.created_at
   AND date_trunc('milliseconds',v.updated_at)=v.updated_at
   AND date_trunc('milliseconds',s.created_at)=s.created_at) AS coherent
FROM rms_catalog.sku s
JOIN rms_catalog.product p ON p.product_id=s.product_id AND p.brand_id=s.brand_id
JOIN rms_catalog.product_version v ON v.product_version_id=s.product_version_id
  AND v.product_id=s.product_id AND v.brand_id=s.brand_id
WHERE s.brand_id=$1 AND s.sku_id=ANY($2::uuid[])
ORDER BY s.sku_id FOR SHARE OF s,p,v`;
const unavailable = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
interface Row {
  sku_id: unknown;
  product_id: unknown;
  product_version_id: unknown;
  brand_id: unknown;
  product_lifecycle: unknown;
  sku_lifecycle: unknown;
  default_locale: unknown;
  product_names: unknown;
  sku_names: unknown;
  product_updated_at: unknown;
  version_updated_at: unknown;
  coherent: boolean;
}
/** Current owned SKU/Product facts, not a sale/publication authorization.
 * Bind all review reads and the eventual write to the same caller transaction.
 */
export function createPostgresMenuReviewProductSource(options: {
  brandReference: string;
  authorize(tx: ProductLifecycleTransaction): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference);
  return async (
    tx: ProductLifecycleTransaction,
    input: {
      sellableReferences: readonly string[];
      observedAt: string;
    },
  ) => {
    try {
      const at = parseCatalogInstant(input.observedAt);
      if (!Array.isArray(input.sellableReferences)) return unavailable();
      const references = input.sellableReferences.map(parseCatalogReference);
      if (new Set(references).size !== references.length) return unavailable();
      const authorize = async () => {
        if ((await options.authorize(tx)) !== true)
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
        [brand],
      );
      const rows = (await tx.query<Row>(select, [brand, references, at])).rows;
      if (rows.length !== references.length) return unavailable();
      const facts = rows.map((row) => {
        const sellableReference = parseCatalogReference(row.sku_id);
        if (
          row.coherent !== true ||
          parseCatalogReference(row.brand_id) !== brand ||
          !references.includes(sellableReference)
        )
          return unavailable();
        const defaultLocale = parseCatalogLocale(row.default_locale);
        const productNames = parseLocalizedNames(row.product_names, defaultLocale);
        // SKU localization is an override; preserve Product fallback translations.
        if (!row.sku_names || typeof row.sku_names !== "object" || Array.isArray(row.sku_names))
          return unavailable();
        const names = parseLocalizedNames({ ...productNames, ...row.sku_names }, defaultLocale);
        return Object.freeze({
          brandReference: brand,
          sellableReference,
          productReference: parseCatalogReference(row.product_id),
          productVersionReference: parseCatalogReference(row.product_version_id),
          productLifecycle: parseProductLifecycle(row.product_lifecycle),
          skuLifecycle: parseProductLifecycle(row.sku_lifecycle),
          defaultLocale,
          localizedNames: names,
          productUpdatedAt: parseCatalogInstant(row.product_updated_at),
          versionUpdatedAt: parseCatalogInstant(row.version_updated_at),
        });
      });
      if (new Set(facts.map((fact) => fact.sellableReference)).size !== references.length)
        return unavailable();
      await authorize();
      return Object.freeze(facts);
    } catch (error) {
      if (error instanceof CatalogError) throw error;
      return unavailable();
    }
  };
}
