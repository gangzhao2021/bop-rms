import type { ConsumerTransaction } from "@bop/eventing";
import {
  excludeUnchargedReceiptBatches,
  listStoreUnpaidBatchCancellations,
  type ReceiptOrderSnapshot,
} from "@rms/ordering";

/**
 * WP-2423 Q5: the Order as receipts see it. Rounds the System cancelled because their payment
 * failed were never charged, so they are left off every receipt (Ordering owner read); paid rounds,
 * including staff-cancelled and refunded ones, stay.
 */
export async function receiptChargedOrder(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  order: ReceiptOrderSnapshot,
): Promise<ReceiptOrderSnapshot> {
  const uncharged = await listStoreUnpaidBatchCancellations(transaction, scope, [
    order.orderReference,
  ]);
  return excludeUnchargedReceiptBatches(
    order,
    uncharged.map((entry) => entry.orderBatchReference),
  );
}
