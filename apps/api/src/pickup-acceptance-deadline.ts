import type { ConsumerTransaction } from "@bop/eventing";
import { listStorePickupAcceptanceDeadlines } from "@rms/fulfillment";
import {
  listStoreOrderAcceptanceHolds,
  listStoreOrdersAwaitingAcceptance,
  type OrderAcceptanceHold,
} from "@rms/ordering";
import { createMerchantBusinessDayWindows } from "./merchant-business-day-window.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

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

/** A paid pickup Order nobody has accepted yet, by its Store order number, and its refund time. */
export interface StoreAwaitingPickupDeadline {
  readonly orderNumber: string;
  readonly acceptBy: string;
}

/**
 * v15 cbff9d6f (DEC-STAFF-SESSION-CONTINUITY 2026-10-17 correction): today's paid pickup Orders
 * still waiting for acceptance at a Store, each with its running refund deadline — the same
 * definition the kitchen display warns from (current business day, no outage hold or chosen
 * refund). Order numbers and times only, never Customer details. The caller has authorized the
 * Store (here: a registered, unrevoked Store tablet) and owns the transaction.
 */
export function createStoreAwaitingPickupDeadlines(options: {
  readonly persistence: Pick<PersistentMerchantBffOptions, "publication" | "now">;
  readonly tenantReference: string;
}) {
  return async (
    transaction: ConsumerTransaction,
    scope: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly timeZone: string;
      readonly at: string;
    },
  ): Promise<readonly StoreAwaitingPickupDeadline[]> => {
    const where = { brandReference: scope.brandReference, storeReference: scope.storeReference };
    const today = await createMerchantBusinessDayWindows({
      persistence: options.persistence,
      scope: { tenantReference: options.tenantReference, ...where },
      timeZone: scope.timeZone,
      // The Store was authorized by the caller in this transaction (the tablet binding).
      authorize: async () => true,
    }).today(transaction, scope.at);
    const waiting = (
      await listStoreOrdersAwaitingAcceptance(transaction, where, {
        since: today.startsAt,
        businessDate: today.businessDate,
        limit: 200,
      })
    ).filter((order) => order.orderType === "Pickup");
    const deadlines = await readPickupRefundDeadlines(
      transaction,
      where,
      waiting.map((order) => order.orderReference),
    );
    return Object.freeze(
      waiting.flatMap((order) => {
        const acceptBy = deadlines.get(order.orderReference);
        return acceptBy === undefined
          ? []
          : [Object.freeze({ orderNumber: order.orderNumber, acceptBy })];
      }),
    );
  };
}
