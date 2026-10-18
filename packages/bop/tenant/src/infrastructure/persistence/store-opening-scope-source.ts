import { parseBrandReference, parseStoreReference } from "../../domain/brand-store.js";

export interface StoreOpeningScopeTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
/**
 * WP-2423: Tenant owner's public confirmation, inside the caller's transaction, that a Store belongs
 * to the Brand and may still be opened (Draft or Active). Suspended and Archived Stores are refused.
 * Exposes no Store content.
 */
export async function confirmStoreOpeningScope(
  tx: StoreOpeningScopeTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<boolean> {
  const brandReference = String(parseBrandReference(scope.brandReference)),
    storeReference = String(parseStoreReference(scope.storeReference));
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brandReference,
    storeReference,
  ]);
  const result = await tx.query(
    "SELECT 1 FROM bop_tenant.store WHERE brand_id=$1 AND store_id=$2 AND lifecycle IN ('Draft','Active')",
    [brandReference, storeReference],
  );
  return result.rows.length === 1;
}
