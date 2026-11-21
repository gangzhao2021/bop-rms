import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresReceiptOrderSource } from "@rms/ordering";
import { createPostgresOrdinaryRefundRequestContextSource } from "@rms/payment";

type Scope = Readonly<{ tenantReference: string; brandReference: string; storeReference: string }>;

/** Units of each item of one batch, from Ordering's order snapshot (item reference → quantity). */
export type BatchUnits = ReadonlyMap<string, number>;
/** Refund-claimed unit ordinals per order item. */
export type ClaimedUnits = ReadonlyMap<string, ReadonlySet<number>>;

/**
 * WP-2423 M10: the units of a batch, read from Ordering's public order read. Read it before
 * Payment's refund fence (the canonical cross-owner lock order, acquireOrdinaryRefundRequestFences).
 */
export async function readBatchUnits(
  tx: ConsumerTransaction,
  scope: Scope,
  input: { orderReference: string; orderBatchReference: string; observedAt: string },
  allowed: () => Promise<boolean>,
): Promise<BatchUnits> {
  const order = await createPostgresReceiptOrderSource({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: async (_tx, request) =>
      request.orderReference === input.orderReference && (await allowed()),
  })(tx, { orderReference: input.orderReference, observedAt: input.observedAt });
  const units = new Map<string, number>();
  for (const { snapshot } of order.items)
    if (String(snapshot.orderBatchReference) === input.orderBatchReference)
      units.set(String(snapshot.orderItemReference), snapshot.quantity);
  return units;
}

/**
 * WP-2423 M10: the units every ordinary refund request still occupying the Order claims (declined
 * requests release theirs), under Payment's Order refund fence.
 */
export async function readClaimedRefundUnits(
  tx: ConsumerTransaction,
  scope: Scope,
  input: { orderReference: string; observedAt: string; operationReference: string },
  allowed: () => Promise<boolean>,
): Promise<ClaimedUnits> {
  const context = await createPostgresOrdinaryRefundRequestContextSource({
    scope,
    fence: "OrderOnly",
    authorize: async (_tx, query) => query.orderReference === input.orderReference && allowed(),
  })(tx, input);
  const claimed = new Map<string, Set<number>>();
  for (const request of context.occupying)
    for (const payment of request.payments)
      for (const item of payment.items) {
        const set = claimed.get(String(item.orderItemReference)) ?? new Set<number>();
        for (const ordinal of item.refundUnitOrdinals) set.add(ordinal);
        claimed.set(String(item.orderItemReference), set);
      }
  return claimed;
}

/**
 * WP-2423 M10: whether every unit of the batch is refunded (or asked to be): counted in units, not
 * in money, so a refund of every dish that leaves the tip still captured counts as all of it.
 */
export function everyBatchUnitClaimed(
  units: BatchUnits,
  claimed: ClaimedUnits,
  extra: readonly { orderItemReference: string; refundUnitOrdinals: readonly number[] }[] = [],
): boolean {
  if (units.size === 0) return false;
  for (const [item, quantity] of units) {
    const set = new Set(claimed.get(item) ?? []);
    for (const entry of extra)
      if (entry.orderItemReference === item)
        for (const ordinal of entry.refundUnitOrdinals) set.add(ordinal);
    for (let ordinal = 1; ordinal <= quantity; ordinal += 1) if (!set.has(ordinal)) return false;
  }
  return true;
}
