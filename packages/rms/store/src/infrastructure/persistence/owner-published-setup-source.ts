interface Transaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
}
interface StoreScope {
  readonly brandReference: string;
  readonly storeReference: string;
}
const installStoreScope = async (tx: Transaction, scope: StoreScope) => {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
};

/**
 * WP-2423 item 13 ③: whether this Store's Owner has published their own Store setup. A TEST Store's
 * first configuration, written by the opening tool, names nothing guests can be quoted from yet.
 */
export async function hasOwnerPublishedStoreSetup(
  tx: Transaction,
  scope: StoreScope,
): Promise<boolean> {
  await installStoreScope(tx, scope);
  const found = await tx.query(
    "SELECT 1 FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND reason_code<>'INTERNAL_TEST_STORE_SETUP' LIMIT 1",
    [scope.brandReference, scope.storeReference],
  );
  return found.rows.length === 1;
}

/**
 * WP-2423 item 9: the order types this Store offers, from its newest published configuration; null
 * when nothing is published yet. For the words on a staff screen, not an order: an order is admitted
 * only through the publication proof (store-operating-status-reader).
 */
export async function readPublishedStoreServiceModes(
  tx: Transaction,
  scope: StoreScope,
  at: string,
): Promise<readonly string[] | null> {
  await installStoreScope(tx, scope);
  const found = await tx.query(
    "SELECT enabled_service_modes FROM rms_store.store_configuration_version WHERE brand_id=$1 AND store_id=$2 AND lifecycle='Published' AND effective_from<=$3::timestamptz ORDER BY configuration_version DESC LIMIT 1",
    [scope.brandReference, scope.storeReference, at],
  );
  const modes = found.rows[0]?.enabled_service_modes;
  return Array.isArray(modes) ? Object.freeze(modes.map(String)) : null;
}
