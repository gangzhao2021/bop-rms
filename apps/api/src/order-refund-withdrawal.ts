import type { ConsumerTransaction } from "@bop/eventing";
import { listOrderItemRefundWithdrawals } from "@rms/ordering";
import { listDeclinedOrdinaryRefundRequests } from "@rms/payment";

interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}

/**
 * WP-2423 M10 (DEC-OWNER-DEFAULTS-2026-11-06 item 4): per order item, how many units staff
 * refunded and chose not to make or hand over. Ordering's withdrawals, counted only while their
 * Payment refund request is not declined (a declined refund returns no money, so the dish is made
 * and handed over again). Owner public reads only; the caller authorizes the Store.
 */
export async function readRefundWithdrawnUnits(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const orders = [...new Set(orderReferences)];
  const result = new Map<string, number>();
  for (let start = 0; start < orders.length; start += 100) {
    const withdrawals = await listOrderItemRefundWithdrawals(
      tx,
      scope,
      orders.slice(start, start + 100),
    );
    if (withdrawals.length === 0) continue;
    const declined = await listDeclinedOrdinaryRefundRequests(
      tx,
      scope,
      withdrawals.map((row) => row.refundRequestReference),
    );
    for (const row of withdrawals)
      if (!declined.has(row.refundRequestReference))
        result.set(
          row.orderItemReference,
          (result.get(row.orderItemReference) ?? 0) + row.withdrawnQuantity,
        );
  }
  return result;
}
