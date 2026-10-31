import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderPaymentDispositionReader,
  createPostgresStaffOrderCancellationReader,
  parseOrderingReference,
} from "@rms/ordering";

/**
 * WP-2423 (double-refund guard): the paid rounds of one Order whose whole payment is owed back, or
 * was already refunded, because the round was cancelled — by staff (including guests who left) or
 * because Ordering found the paid round could no longer be fulfilled. Their units are never
 * refunded again by an ordinary item refund: the cancellation refund (compensation online, or the
 * recorded card-machine refund) covers the whole round. Ordering owner reads only; the caller
 * holds its authorized transaction.
 */
export function createRoundCancellationRefundSource(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReference: string,
) {
  let cancelled: Promise<ReadonlySet<string>> | null = null;
  const dispositions = createPostgresOrderPaymentDispositionReader(scope);
  return async (round: {
    readonly orderBatchReference: string;
    /** The round's captured payment event (online terminal event or card-machine record). */
    readonly paymentEventReference: string;
  }): Promise<boolean> => {
    cancelled ??= createPostgresStaffOrderCancellationReader(scope)
      .listByOrders(tx, [orderReference])
      .then(
        (records) =>
          new Set(
            records
              .filter((record) => String(record.orderReference) === orderReference)
              .map((record) => String(record.orderBatchReference)),
          ),
      );
    if ((await cancelled).has(round.orderBatchReference)) return true;
    const outcome = await dispositions.loadByPaymentEvent({
      transaction: tx,
      paymentEventReference: parseOrderingReference(round.paymentEventReference),
    });
    const record = outcome?.record as { disposition?: unknown } | undefined;
    return record?.disposition === "PaidWithoutFulfillableOrder";
  };
}
