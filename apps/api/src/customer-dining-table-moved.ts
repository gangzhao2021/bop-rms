import { DiningCheckoutStoreError } from "@rms/dining";
import { OrderCreationError } from "@rms/ordering";

/**
 * WP-2423 (table-move-payment review, 2026-11-06): staff moved the party off the table a round was
 * being sent from after it was prepared. Dining refuses to send it from the old table; Ordering
 * passes the refusal on unchanged (nothing written, nothing charged) and the guest's phone starts
 * checkout again at the table the party sits at now, instead of retrying the same checkout until
 * it lapses.
 */
export async function refuseRoundOfMovedTable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (
      error instanceof DiningCheckoutStoreError &&
      error.code === "DINING_CHECKOUT_STORE_TABLE_MOVED"
    )
      throw new OrderCreationError("ORDER_CREATE_TABLE_MOVED");
    throw error;
  }
}
