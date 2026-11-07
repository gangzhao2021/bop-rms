import type { ConsumerTransaction } from "@bop/eventing";
import {
  excludeUnchargedReceiptBatches,
  listStoreUnpaidBatchCancellations,
  type ReceiptOrderSnapshot,
} from "@rms/ordering";
import { createPostgresCapturedBatchPaymentSource } from "@rms/payment";

/**
 * WP-2423 Q5: the Order as receipts see it at `observedAt`. A receipt covers what was charged:
 * rounds the System cancelled because their payment failed were never charged, and a round still
 * waiting for payment (a staff round not yet paid on the card machine, or a guest round whose
 * checkout has not succeeded) has not been charged yet, so both are left off (Ordering and
 * Payment owner reads). Paid rounds, including staff-cancelled and refunded ones, stay. When a
 * waiting round is paid later, its own payment issues the next receipt version.
 */
export async function receiptChargedOrder(
  transaction: ConsumerTransaction,
  scope: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly providerAccountReference: string;
    readonly environment: "Test" | "Live";
  },
  order: ReceiptOrderSnapshot,
  observedAt: string,
): Promise<ReceiptOrderSnapshot> {
  const uncharged = new Set(
    (
      await listStoreUnpaidBatchCancellations(
        transaction,
        { brandReference: scope.brandReference, storeReference: scope.storeReference },
        [order.orderReference],
      )
    ).map((entry) => entry.orderBatchReference),
  );
  const captured = createPostgresCapturedBatchPaymentSource({
    scope,
    authorize: async (_tx, query) => query.orderReference === order.orderReference,
  });
  for (const batch of order.batches) {
    if (uncharged.has(batch.orderBatchReference)) continue;
    const paid = await captured.load(transaction, {
      orderReference: order.orderReference,
      orderBatchReference: batch.orderBatchReference,
      observedAt,
    });
    if (paid === null) uncharged.add(batch.orderBatchReference);
  }
  return excludeUnchargedReceiptBatches(order, [...uncharged]);
}
