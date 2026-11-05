/**
 * WP-2423 item 13 ③: whether this Store's Owner has published their own Store setup. A TEST Store's
 * first configuration, written by the opening tool, names nothing guests can be quoted from yet.
 */
export async function hasOwnerPublishedStoreSetup(
  tx: {
    query(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  },
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<boolean> {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
  const found = await tx.query(
    "SELECT 1 FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND reason_code<>'INTERNAL_TEST_STORE_SETUP' LIMIT 1",
    [scope.brandReference, scope.storeReference],
  );
  return found.rows.length === 1;
}
