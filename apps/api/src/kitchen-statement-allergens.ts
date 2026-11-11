import { currentAllergenRegistry } from "@rms/catalog";

/** WP-2423 (M178): shared by the staff statement page and the guest store profile. */
interface Tx {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

/** The Brand's allergen list (codes and names) read with no Store selected; the Store is restored. */
export async function kitchenStatementAllergens(
  tx: unknown,
  scope: { readonly brandReference: string; readonly storeReference: string },
): Promise<readonly { readonly code: string; readonly names: Readonly<Record<string, string>> }[]> {
  const registry = await currentAllergenRegistry(tx as never, scope);
  await (tx as Tx).query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, scope.storeReference],
  );
  return (registry?.entries ?? []).map((entry) => ({
    code: String(entry.code),
    names: entry.localizedNames as Readonly<Record<string, string>>,
  }));
}
