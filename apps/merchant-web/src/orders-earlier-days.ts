import { isAwaitingAcceptance, type CurrentOrderQueue } from "./current-order-queue-client.js";

/*
 * Which orders of earlier business days are still unfinished, as Orders lists them under "Earlier
 * days · not finished". Batch 63 (F23): Home counts them with the same rule, so both pages say the
 * same number.
 */

/** The Store's current business day as Orders needs it: its date and when it began. */
export type OrdersBusinessDay = Readonly<{ businessDate: string; startsAt: string }>;
/**
 * Batch 56 (v15 batch 55 live, Test Merchant 2): a table order of Wed Nov 4 ("11/4 · 2") whose only
 * round was still waiting to be accepted 19 days later was listed first under "Today", above the
 * real New order, as if it were today's work. An order of an earlier business day that has sent
 * nothing since today began, but still has a round to accept, is a leftover: it is listed with the
 * earlier days' unfinished orders, Needs attention names it, its row says so, and the To accept tab
 * still lists it. It is never hidden or dropped. A table of an earlier day that sent a round today
 * stays with today's orders.
 */
export function earlierDayWaiting(
  order: CurrentOrderQueue["items"][number],
  day: OrdersBusinessDay | null,
): boolean {
  if (day === null || order.businessDate === null || order.businessDate >= day.businessDate)
    return false;
  if (order.heldStock !== null || order.earlierOpenPickup || !isAwaitingAcceptance(order))
    return false;
  const dayStart = Date.parse(day.startsAt);
  return !order.batches.some(
    (batch) => Date.parse(batch.submittedAt ?? order.submittedAt) >= dayStart,
  );
}
/** An earlier day's order still to finish: holding stock, an open pickup, or a round waiting. */
export function earlierDayUnfinished(
  order: CurrentOrderQueue["items"][number],
  day: OrdersBusinessDay | null,
): boolean {
  return order.heldStock !== null || order.earlierOpenPickup || earlierDayWaiting(order, day);
}
