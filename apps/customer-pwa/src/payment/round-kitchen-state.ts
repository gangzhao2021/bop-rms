import {
  OrderStatusClientError,
  parseOrderStatusView,
  type CustomerOrderStatusClient,
} from "../order-status/order-status-controller.js";
import type { OrderStatusView } from "../order-status/types.js";

/**
 * WP-2423: where a paid round stands after checkout. A paid round reaches the kitchen only once
 * staff accept it (dine-in rounds since the per-round acceptance; pickup orders the Store
 * accepts), so the payment result must not claim it was sent before the kitchen has it.
 * `Checking` until the order status is read; `Other` when it can't be told or the round ended.
 */
export type RoundKitchenState = "Checking" | "AwaitingStaff" | "SentToKitchen" | "Other";

/** The paid round's place, from the customer order status read (Kitchen's ticket is the proof). */
export function roundKitchenState(
  view: OrderStatusView,
  orderBatchReference: string,
): Exclude<RoundKitchenState, "Checking"> {
  if (!view.order.batches.some((batch) => batch.orderBatchReference === orderBatchReference))
    return "Other";
  const ticket = view.sources?.kitchen?.batches.find(
    (batch) => batch.orderBatchReference === orderBatchReference,
  );
  if (ticket) return ticket.status === "Cancelled" ? "Other" : "SentToKitchen";
  const sources = view.sources;
  if (sources === undefined) return "Other";
  const ended =
    view.order.canonicalPhase === "Cancelled" ||
    view.order.canonicalPhase === "Rejected" ||
    view.order.canonicalPhase === "Fulfilled" ||
    sources.storeAcceptance?.state === "NotAccepted" ||
    (sources.staffCancellations ?? []).some(
      (entry) => entry.orderBatchReference === orderBatchReference,
    ) ||
    (sources.unpaidCancellations ?? []).some(
      (entry) => entry.orderBatchReference === orderBatchReference,
    );
  return ended ? "Other" : "AwaitingStaff";
}

/** While staff have not sent it yet, the page checks again with a growing delay, this often. */
export const roundKitchenPollDelaysMs = [5_000, 10_000, 15_000, 30_000] as const;
export const roundKitchenPollLimit = 40;

/**
 * Watches one paid round until the kitchen has it (or it can't be told). Reads only the existing
 * customer order status; nothing is written and no reference is ever shown.
 */
export function createRoundKitchenWatch(input: {
  readonly client: CustomerOrderStatusClient;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly onChange: (state: RoundKitchenState) => void;
  readonly setTimer?: (run: () => void, delayMs: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}): () => void {
  const setTimer =
    input.setTimer ?? ((run: () => void, delayMs: number) => globalThis.setTimeout(run, delayMs));
  const clearTimer =
    input.clearTimer ??
    ((timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));
  let stopped = false,
    checks = 0,
    timer: unknown = null,
    state: RoundKitchenState = "Checking";
  const publish = (next: RoundKitchenState) => {
    if (next === state) return;
    state = next;
    input.onChange(next);
  };
  const again = () => {
    if (stopped || checks >= roundKitchenPollLimit) return;
    const delay =
      roundKitchenPollDelaysMs[Math.min(checks - 1, roundKitchenPollDelaysMs.length - 1)] ??
      roundKitchenPollDelaysMs[0];
    timer = setTimer(() => void check(), delay);
  };
  const check = async () => {
    if (stopped) return;
    checks++;
    try {
      const view = parseOrderStatusView(
        await input.client.load(input.orderReference),
        input.orderReference,
      );
      if (stopped) return;
      const next = roundKitchenState(view, input.orderBatchReference);
      publish(next);
      if (next === "AwaitingStaff") again();
    } catch (error) {
      if (stopped) return;
      // The visit ended or the order can't be read here: say only what is known.
      if (error instanceof OrderStatusClientError && error.code !== "service_unavailable") {
        publish("Other");
        return;
      }
      // A passing failure keeps what was last known and checks again.
      if (state === "Checking") publish("Other");
      again();
    }
  };
  void check();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
  };
}

/** The payment result's opening line for a confirmed payment, in the guest's words. */
export function paidIntroText(state: RoundKitchenState | null): string {
  return state === "SentToKitchen"
    ? "Thank you. Your order has been sent to the kitchen."
    : state === "AwaitingStaff"
      ? "Paid. The staff will send it to the kitchen shortly."
      : "Thank you. Your payment went through.";
}
