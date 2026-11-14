import type { ConsumerTransaction } from "@bop/eventing";
import {
  acquireOrderDispositionFence,
  createPostgresOrderRoundStaffHoldStore,
  type OrderRoundHold,
} from "@rms/ordering";

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN decisions 5–7: the guest rounds of these Orders that wait for
 * staff now (held, not released). They are not in the kitchen, not on the table's bill and never
 * cancelled by time; staff send them to the kitchen or cancel them. Every reader that tells such a
 * round apart — Tables, the Orders panel, checkout and closing — reads it here, so they always
 * agree on which rounds wait. At most 200 Orders per call (Ordering's limit).
 */
export async function listRoundsWaitingForStaff(
  tx: ConsumerTransaction,
  owner: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
  authorize: () => Promise<boolean>,
): Promise<readonly OrderRoundHold[]> {
  if (orderReferences.length === 0) return Object.freeze([]);
  return createPostgresOrderRoundStaffHoldStore({
    brandReference: owner.brandReference,
    storeReference: owner.storeReference,
    authorize: async () => (await authorize()) === true,
  }).listWaiting({ transaction: tx, orderReferences });
}

/**
 * The serialization point of a table's bill (WP-2423 item 8 ⑤ D4): every command that takes the
 * table's payment, and every staff "Send to kitchen" of a round waiting for staff, holds the
 * Ordering disposition fence of the Orders on the bill before it reads them. That is the fence
 * releasing a held round takes and every bill read already takes (Ordering's priced total), so the
 * lock order stays the one the payment writers use (the Order's fence, then the bill's payment
 * key). A payment and a "Send to kitchen" therefore run one after the other: a round can never
 * become owed on a bill that was paid meanwhile, nor a payment take a bill that changed.
 */
export async function fenceTableBill(
  tx: ConsumerTransaction,
  owner: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<void> {
  // A fixed order (the bill Order first, as listOrderBillOrders gives them) on every path.
  for (const orderReference of orderReferences)
    await acquireOrderDispositionFence(tx, { ...owner, orderReference });
}
