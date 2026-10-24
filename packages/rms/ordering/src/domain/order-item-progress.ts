import { parseOrderingReference } from "./cart.js";

export type OrderItemProgressPhase =
  "Submitted" | "Accepted" | "InProgress" | "Ready" | "Fulfilled" | "Rejected" | "Cancelled";

export interface OrderItemProgressFact {
  readonly orderItemReference: string;
  readonly phase: OrderItemProgressPhase;
  readonly everAccepted: boolean;
  readonly everStarted: boolean;
}

/** DEC-PILOT-BATCH-PHASE-01. Caller resolves all scoped owner facts under its fence.
 * This result grants no cancellation permission and never closes an Order.
 */
export function summarizeOrderItemProgress(items: readonly OrderItemProgressFact[]) {
  if (!Array.isArray(items) || items.length === 0) throw new Error("ORDER_ITEM_PROGRESS_INVALID");
  const seen = new Set<string>();
  for (const item of items) {
    const reference = parseOrderingReference(item.orderItemReference);
    if (
      seen.has(reference) ||
      typeof item.everAccepted !== "boolean" ||
      typeof item.everStarted !== "boolean" ||
      ![
        "Submitted",
        "Accepted",
        "InProgress",
        "Ready",
        "Fulfilled",
        "Rejected",
        "Cancelled",
      ].includes(item.phase) ||
      (item.everStarted && !item.everAccepted) ||
      (["Accepted", "InProgress", "Ready", "Fulfilled"].includes(item.phase) &&
        !item.everAccepted) ||
      (item.phase === "InProgress" && !item.everStarted)
    )
      throw new Error("ORDER_ITEM_PROGRESS_INVALID");
    seen.add(reference);
  }
  const active = items.filter((item) => item.phase !== "Rejected" && item.phase !== "Cancelled");
  const everAccepted = items.some((item) => item.everAccepted);
  const everStarted = items.some((item) => item.everStarted);
  const phase: OrderItemProgressPhase =
    active.length === 0
      ? !everAccepted && items.every((item) => item.phase === "Rejected")
        ? "Rejected"
        : "Cancelled"
      : active.every((item) => item.phase === "Fulfilled")
        ? "Fulfilled"
        : active.every((item) => item.phase === "Ready" || item.phase === "Fulfilled")
          ? "Ready"
          : active.some(
                (item) => item.everStarted || item.phase === "Ready" || item.phase === "Fulfilled",
              )
            ? "InProgress"
            : active.some((item) => item.everAccepted)
              ? "Accepted"
              : "Submitted";
  return Object.freeze({ phase, everAccepted, everStarted });
}

/** Merge current preparation with delivery facts from the fulfillment owner.
 * Partial delivery does not make an item Fulfilled and never closes an Order.
 */
export function resolveOrderItemDeliveryProgress(
  item: OrderItemProgressFact & {
    readonly orderedQuantity: number;
    readonly deliveredQuantity: number;
  },
) {
  summarizeOrderItemProgress([item]);
  if (
    !Number.isSafeInteger(item.orderedQuantity) ||
    item.orderedQuantity < 1 ||
    item.orderedQuantity > 999 ||
    !Number.isSafeInteger(item.deliveredQuantity) ||
    item.deliveredQuantity < 0 ||
    item.deliveredQuantity > item.orderedQuantity ||
    (item.deliveredQuantity > 0 && item.phase !== "Ready" && item.phase !== "Fulfilled") ||
    (item.phase === "Fulfilled" && item.deliveredQuantity !== item.orderedQuantity)
  )
    throw new Error("ORDER_ITEM_DELIVERY_INVALID");
  return Object.freeze({
    orderItemReference: item.orderItemReference,
    phase: item.deliveredQuantity === item.orderedQuantity ? ("Fulfilled" as const) : item.phase,
    everAccepted: item.everAccepted,
    everStarted: item.everStarted,
    orderedQuantity: item.orderedQuantity,
    deliveredQuantity: item.deliveredQuantity,
    remainingQuantity: item.orderedQuantity - item.deliveredQuantity,
  });
}
