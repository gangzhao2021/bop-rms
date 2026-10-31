import { parseBrandReference } from "../../domain/brand-store.js";

export interface BrandStoreIdsTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
/**
 * WP-2423 DEC-BRAND-MULTI-STORE segment 9: the Tenant owner's public read, inside the caller's
 * transaction, of which Stores of the Brand are not archived (2000_138), held until the
 * transaction ends so a Store being added waits for it. References only; no Store content.
 * Leaves the transaction scoped to the Brand (no Store).
 */
export async function listBrandStoreReferences(
  tx: BrandStoreIdsTransaction,
  scope: { readonly brandReference: string },
): Promise<readonly string[]> {
  const brandReference = String(parseBrandReference(scope.brandReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
    brandReference,
  ]);
  const result = await tx.query("SELECT bop_tenant.brand_store_ids($1)::text AS store", [
    brandReference,
  ]);
  return Object.freeze(result.rows.map((row) => String(row.store)));
}
