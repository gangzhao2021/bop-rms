import type { ConsumerTransaction } from "@bop/eventing";
import { listStorePickupAcceptanceDeadlines } from "@rms/fulfillment";
import { listStoreOrderAcceptanceHolds, type OrderAcceptanceHold } from "@rms/ordering";

/**
 * WP-2423 Q1 / Q9-G1: a paid pickup Order's current acceptance deadline. Without an outage hold it
 * is Fulfillment's capacity expiry; a held Order has none while the Store is offline (null), then
 * the manager's decision deadline once staff are back. `refundChosen`: a manager chose to refund,
 * so the closure is deliberate and nobody needs warning about it.
 */
export function pickupAcceptanceDeadline(
  standard: string | null,
  hold: OrderAcceptanceHold | null,
): {
  readonly acceptBy: string | null;
  readonly decideBy: string | null;
  readonly refundChosen: boolean;
} {
  if (hold === null) return { acceptBy: standard, decideBy: null, refundChosen: false };
  const decideBy =
    hold.resolutions.length === 0
      ? null
      : hold.resolutions
          .map((entry) => entry.decideBy)
          .reduce((earliest, value) => (value < earliest ? value : earliest));
  return {
    acceptBy: decideBy,
    decideBy,
    refundChosen: hold.resolutions.some((entry) => entry.resolution === "StaffRefund"),
  };
}

/**
 * WP-2423 (Warn before timeouts): when each listed paid pickup Order not yet accepted is refunded
 * automatically unless someone accepts it — null while it is held for an outage or once a manager
 * chose the refund. Orders without a running deadline are omitted. Caller authorizes the Store and
 * owns the transaction.
 */
export async function readPickupRefundDeadlines(
  transaction: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (orderReferences.length === 0) return new Map();
  const holds = await listStoreOrderAcceptanceHolds(transaction, scope, orderReferences);
  const standard = await listStorePickupAcceptanceDeadlines(transaction, scope, orderReferences);
  const deadlines = new Map<string, string>();
  for (const reference of orderReferences) {
    const current = pickupAcceptanceDeadline(
      standard.get(reference) ?? null,
      holds.get(reference) ?? null,
    );
    if (current.acceptBy !== null && !current.refundChosen)
      deadlines.set(reference, current.acceptBy);
  }
  return deadlines;
}
