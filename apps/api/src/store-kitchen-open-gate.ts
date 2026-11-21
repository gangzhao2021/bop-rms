import { storeKitchenRoutingInEffect } from "@rms/kitchen";
import { createPostgresPublishedStoreOperatingStatusReader } from "@rms/store";

type Operating = Parameters<typeof createPostgresPublishedStoreOperatingStatusReader>[0];
type Transaction = Parameters<
  ReturnType<typeof createPostgresPublishedStoreOperatingStatusReader>
>[0];

/**
 * WP-2423 item 11 (Owner 2026-11-01): a Store takes no order until its kitchen routing is in effect.
 * The kitchen routes an order by the routing in effect when it was confirmed and a routing is never
 * back-dated, so an order taken before then would be paid and never reach a kitchen. Every path
 * that takes an order (guest entry, checkout and payment, counter, staff rounds) reads the Store's
 * status through here, so they refuse together, as closed; Stores with routing are unaffected.
 */
export async function storeKitchenReady(
  tx: Transaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  at: string,
): Promise<boolean> {
  const query = tx as unknown as Parameters<typeof storeKitchenRoutingInEffect>[0];
  // The caller's scope is left as it was: its later reads may be Brand-level.
  const prior = (
    await query.query(
      "SELECT current_setting('bop.brand_id',true) brand,current_setting('bop.store_id',true) store",
      [],
    )
  ).rows[0] as { brand: string | null; store: string | null };
  const ready = await storeKitchenRoutingInEffect(query, scope, at);
  await query.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [prior.brand ?? "", prior.store ?? ""],
  );
  return ready;
}

export function createKitchenGatedOperatingStatusReader(options: Operating) {
  const read = createPostgresPublishedStoreOperatingStatusReader(options);
  return async (tx: Transaction, at: string) => {
    const status = await read(tx, at);
    if (
      await storeKitchenReady(
        tx,
        { brandReference: options.brandReference, storeReference: options.storeReference },
        at,
      )
    )
      return status;
    return Object.freeze({
      ...status,
      state: "Closed" as const,
      kitchenNotSetUp: true,
      availableServiceModes: Object.freeze([]) as typeof status.availableServiceModes,
      scheduledServiceModes: Object.freeze([]) as typeof status.scheduledServiceModes,
    });
  };
}
