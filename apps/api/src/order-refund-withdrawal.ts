import type { ConsumerTransaction } from "@bop/eventing";
import { listOrderItemRefundWithdrawals } from "@rms/ordering";
import {
  listDeclinedOrdinaryRefundRequests,
  listOrdinaryRefundRequesterRoles,
  type OrdinaryRefundRequesterRole,
} from "@rms/payment";

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
  const lines = await readRefundWithdrawnLines(tx, scope, orderReferences);
  return new Map([...lines].map(([item, line]) => [item, line.quantity]));
}

/**
 * WP-2423 M10: as readRefundWithdrawnUnits, with who refunded them (the staff members who chose
 * "stop making it too", oldest first), so the cook's ticket says whose decision it was, and each
 * one's refund request (whose recorded role names them when their name can't be read).
 */
export async function readRefundWithdrawnLines(
  tx: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<
  ReadonlyMap<
    string,
    {
      readonly quantity: number;
      readonly actorReferences: readonly string[];
      readonly requestByActor: ReadonlyMap<string, string>;
    }
  >
> {
  const orders = [...new Set(orderReferences)];
  const result = new Map<
    string,
    { quantity: number; actorReferences: string[]; requestByActor: Map<string, string> }
  >();
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
      if (!declined.has(row.refundRequestReference)) {
        const line = result.get(row.orderItemReference) ?? {
          quantity: 0,
          actorReferences: [],
          requestByActor: new Map<string, string>(),
        };
        line.quantity += row.withdrawnQuantity;
        if (!line.actorReferences.includes(row.actorReference)) {
          line.actorReferences.push(row.actorReference);
          line.requestByActor.set(row.actorReference, row.refundRequestReference);
        }
        result.set(row.orderItemReference, line);
      }
  }
  return result;
}

/**
 * WP-2423 M10: the refund role each request's requester held when it was recorded (Owner, Manager
 * or Staff), so a refunder without a name in the member directory is still named by role ("the
 * owner"). Payment's owner read; a request recorded before roles were kept is left out.
 */
export async function readRefundRequesterRoles(
  tx: ConsumerTransaction,
  scope: Scope,
  requestReferences: readonly string[],
): Promise<ReadonlyMap<string, OrdinaryRefundRequesterRole>> {
  return listOrdinaryRefundRequesterRoles(tx, scope, [...new Set(requestReferences)]);
}
