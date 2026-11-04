import {
  parseCatalogReference,
  parseProductAggregate,
  type ProductAggregate,
} from "../../contracts/product.js";
import { productSnapshotSelectSql } from "./product-lifecycle-store.js";

/**
 * WP-2423 / DEC-CAT-PRODUCT-ADMIN: Brand Product list and detail for the back office. Reads the current
 * Product and its current version with sizes (SKUs). Caller authorizes (catalog.product.read) and owns
 * the transaction; the Brand scope is set with an empty Store.
 */
interface Tx {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
export interface BrandProductSummary {
  readonly productReference: string;
  readonly internalCode: string;
  readonly productType: string;
  readonly lifecycle: string;
  readonly aggregateVersion: number;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly taxClassificationReference: string | null;
  readonly sizes: number;
  readonly activeSizes: number;
  readonly updatedAt: string;
}
const brandScope = async (tx: Tx, brand: string) =>
  tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [brand]);

export async function listBrandProducts(
  tx: Tx,
  scope: { readonly brandReference: string },
): Promise<readonly BrandProductSummary[]> {
  const brand = parseCatalogReference(scope.brandReference);
  await brandScope(tx, brand);
  return (
    await tx.query(
      `SELECT p.product_id::text product,p.internal_code,p.product_type,p.lifecycle,p.aggregate_version,
        v.localized_names_json names,v.tax_classification_id::text tax,
        to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') updated,
        (SELECT count(*) FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id
          AND s.product_version_id=v.product_version_id)::int sizes,
        (SELECT count(*) FROM rms_catalog.sku s WHERE s.brand_id=p.brand_id AND s.product_id=p.product_id
          AND s.product_version_id=v.product_version_id AND s.lifecycle='Active')::int active_sizes
       FROM rms_catalog.product p JOIN rms_catalog.product_version v
        ON v.product_id=p.product_id AND v.brand_id=p.brand_id AND v.status='Draft'
       WHERE p.brand_id=$1 ORDER BY p.lifecycle='Archived',p.internal_code LIMIT 1000`,
      [brand],
    )
  ).rows.map((row) =>
    Object.freeze({
      productReference: String(row.product),
      internalCode: String(row.internal_code),
      productType: String(row.product_type),
      lifecycle: String(row.lifecycle),
      aggregateVersion: Number(row.aggregate_version),
      localizedNames: (row.names ?? {}) as Readonly<Record<string, string>>,
      taxClassificationReference: row.tax === null ? null : String(row.tax),
      sizes: Number(row.sizes),
      activeSizes: Number(row.active_sizes),
      updatedAt: String(row.updated),
    }),
  );
}

/**
 * Owner 2026-11-04: the menu sections each Product sits in on the Brand's current menus, in menu
 * order (absent: on no menu). The owner names these sections, so they are how a list groups dishes.
 */
export async function listBrandProductSections(
  tx: Tx,
  scope: { readonly brandReference: string },
): Promise<
  ReadonlyMap<
    string,
    readonly { readonly names: Readonly<Record<string, string>>; readonly order: number }[]
  >
> {
  const brand = parseCatalogReference(scope.brandReference);
  await brandScope(tx, brand);
  const { rows } = await tx.query(
    `SELECT sk.product_id::text product,s.menu_section_id::text section,s.localized_names_json names,
       s.sort_order section_order,min(p.sort_order) placement_order
      FROM rms_catalog.menu m
      JOIN rms_catalog.menu_section s ON s.menu_version_id=m.current_version_id AND s.menu_id=m.menu_id AND s.brand_id=m.brand_id
      JOIN rms_catalog.sellable_placement p ON p.menu_section_id=s.menu_section_id AND p.menu_id=s.menu_id AND p.brand_id=s.brand_id
      JOIN rms_catalog.sku sk ON sk.sku_id=p.sku_id AND sk.brand_id=p.brand_id
      WHERE m.brand_id=$1
      GROUP BY sk.product_id,s.menu_section_id,s.localized_names_json,s.sort_order
      ORDER BY s.sort_order,placement_order`,
    [brand],
  );
  const found = new Map<string, { names: Readonly<Record<string, string>>; order: number }[]>();
  for (const row of rows) {
    const entries = found.get(String(row.product)) ?? [];
    entries.push({
      names: (row.names ?? {}) as Readonly<Record<string, string>>,
      // Sections first, then the dish's place within its section.
      order: Number(row.section_order) * 100_000 + Number(row.placement_order),
    });
    found.set(String(row.product), entries);
  }
  return found;
}

/** The Product with its current version; null when it does not belong to the Brand. */
export async function loadBrandProduct(
  tx: Tx,
  scope: { readonly brandReference: string },
  productReference: string,
): Promise<ProductAggregate | null> {
  const brand = parseCatalogReference(scope.brandReference);
  const product = parseCatalogReference(productReference);
  await brandScope(tx, brand);
  const rows = (await tx.query(productSnapshotSelectSql, [brand, product])).rows;
  if (rows.length !== 1 || !rows[0]) return null;
  return parseProductAggregate(rows[0].snapshot);
}

/**
 * WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: the sellables on the Store's current published menus (every
 * active menu projection that applies to the Store). A Store's price book must price each of them.
 */
export async function listStoreMenuSellables(
  tx: Tx,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<readonly string[]> {
  const brand = parseCatalogReference(scope.brandReference);
  const store = parseCatalogReference(scope.storeReference);
  await brandScope(tx, brand);
  return (
    await tx.query(
      `SELECT DISTINCT v.sellable_id::text sellable
       FROM rms_catalog.published_menu_projection_checkpoint c
       JOIN rms_catalog.published_menu_projection_generation g ON g.generation_id=c.active_generation_id
        AND g.menu_id=c.menu_id AND g.brand_id=c.brand_id AND g.generation_status='Active'
       JOIN rms_catalog.published_menu_projection p ON p.generation_id=g.generation_id AND p.menu_id=g.menu_id
        AND p.brand_id=g.brand_id
       JOIN rms_catalog.published_menu_projection_sellable v ON v.generation_id=p.generation_id
        AND v.menu_id=p.menu_id AND v.brand_id=p.brand_id
       WHERE c.consumer_name='catalog.published-menu-projection' AND c.brand_id=$1
        AND (p.store_ids_json IS NULL OR p.store_ids_json='[]'::jsonb OR p.store_ids_json @> jsonb_build_array($2::text))
       ORDER BY 1`,
      [brand, store],
    )
  ).rows.map((row) => String(row.sellable));
}

/**
 * WP-2423 / DEC-CAT-PRODUCT-ADMIN: each Product version's tax classification (for quotes). Reads in the
 * Brand scope and restores the caller's Store scope afterwards.
 */
export async function listProductVersionTaxClassifications(
  tx: Tx,
  scope: { readonly brandReference: string },
  productVersionReferences: readonly string[],
): Promise<ReadonlyMap<string, string | null>> {
  const brand = parseCatalogReference(scope.brandReference);
  const versions = productVersionReferences.map(parseCatalogReference);
  const previous = (await tx.query("SELECT current_setting('bop.store_id',true) store", [])).rows[0]
    ?.store;
  await brandScope(tx, brand);
  try {
    const rows = (
      await tx.query(
        `SELECT product_version_id::text version,tax_classification_id::text tax FROM rms_catalog.product_version
         WHERE brand_id=$1 AND product_version_id=ANY($2::uuid[])`,
        [brand, versions],
      )
    ).rows;
    return new Map(
      rows.map((row) => [String(row.version), row.tax === null ? null : String(row.tax)]),
    );
  } finally {
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [
      typeof previous === "string" ? previous : "",
    ]);
  }
}
