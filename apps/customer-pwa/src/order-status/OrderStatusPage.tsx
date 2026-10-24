import { listSeparator, useReloadOnLanguageChange } from "../i18n/i18n.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import {
  createOrderStatusController,
  createUnavailableOrderStatusClient,
  type OrderStatusController,
} from "./order-status-controller.js";
import type {
  ItemCancellation,
  OrderRefunds,
  OrderStatusState,
  OrderStatusView,
  StaffCancellation,
  StaffCancellationReason,
} from "./types.js";
import { PickupCodePanel } from "../pickup-code/PickupCodePanel.js";
import type { PickupCodeController } from "../pickup-code/pickup-code-controller.js";
import { CustomerPage, type CustomerStoreContext } from "../journey/CustomerPage.js";
import {
  describeChosenOption,
  endSentence,
  formatClockTime,
  formatMoney,
} from "../journey/format.js";
import { StoreContactCard } from "../journey/StoreContact.js";
import { commonText, orderStatusText } from "../journey/messages.js";
import { ContactDetailsSection } from "./ContactDetailsSection.js";
import type { ContactRemovalClient } from "./contact-removal-client.js";
import {
  getCustomerCsrfCredential,
  getEndedVisitReceiptAccess,
} from "../session/customer-transaction-context.js";

/**
 * WP-2423 D5: the order's money as a receipt prints it — each item at its price before tax, then
 * the subtotal, tax and total — over the rounds that are charged. Without the frozen item prices
 * (an older server) items keep their totals including tax and only the total is printed.
 */
export interface OrderMoneySummary {
  readonly itemAmount: (orderItemReference: string, lineTotal: bigint) => bigint;
  readonly subtotal: bigint | null;
  readonly tax: bigint | null;
  /** Discounts and fees the items carried (zero unless the order had any). */
  readonly adjustments: bigint | null;
  /**
   * WP-2423 (v15 aa3d9fac D2): the tips paid with the charged rounds (zero when none), as the
   * server recorded them; `total` includes them, so it is what was paid and what the receipt prints.
   */
  readonly tip: bigint;
  readonly total: bigint;
}

export function orderMoneySummary(
  view: OrderStatusView,
  charged: (orderBatchReference: string) => boolean,
): OrderMoneySummary {
  const prices = new Map(
    (view.sources?.itemPrices ?? []).map((price) => [price.orderItemReference, price] as const),
  );
  const items = view.order.batches
    .filter((batch) => charged(batch.orderBatchReference))
    .flatMap((batch) => batch.items);
  const itemsTotal = items.reduce((sum, item) => sum + item.lineTotal.amountMinor, 0n);
  const tip = (view.sources?.tips ?? [])
    .filter((entry) => charged(entry.orderBatchReference))
    .reduce((sum, entry) => sum + entry.amount.amountMinor, 0n);
  const total = itemsTotal + tip;
  const priced =
    prices.size > 0 &&
    view.order.batches.every((batch) =>
      batch.items.every((item) => prices.has(item.orderItemReference)),
    );
  if (!priced)
    return {
      itemAmount: (_reference, lineTotal) => lineTotal,
      subtotal: null,
      tax: null,
      adjustments: null,
      tip,
      total,
    };
  const subtotal = items.reduce(
    (sum, item) => sum + (prices.get(item.orderItemReference)?.subtotal.amountMinor ?? 0n),
    0n,
  );
  const tax = items.reduce(
    (sum, item) => sum + (prices.get(item.orderItemReference)?.tax.amountMinor ?? 0n),
    0n,
  );
  return {
    itemAmount: (reference, lineTotal) => prices.get(reference)?.subtotal.amountMinor ?? lineTotal,
    subtotal,
    tax,
    adjustments: itemsTotal - subtotal - tax,
    tip,
    total,
  };
}

/** How often an active order re-reads its status when no live connection is available. */
export const orderStatusPollIntervalMs = 15_000;
/** WP-2423: how often a just-received order checks again until its status is ready to show. */
export const orderReceivedPollIntervalMs = 2_000;
/**
 * WP-2423 (v15 2026-10-16): a ready pickup order means the guest is at the counter with the code on
 * screen; check often so the page turns to "collected" within seconds of the handoff, not ~10 s.
 */
export const orderAwaitingCollectionPollIntervalMs = 3_000;
/**
 * WP-2423 (v15 2026-10-16): an accepted order the kitchen is still making. The guest is watching for
 * "Ready" (a pickup guest is often already at the counter), so the page must turn within a few
 * seconds of the kitchen finishing, not after a 15 s wait. This deployment has no live channel for
 * guests (`/bff/realtime` is not wired and the HTTP client reports live updates unavailable), so
 * this pace is the update path.
 */
export const orderPreparingPollIntervalMs = 3_000;
/**
 * WP-2423 (v15 2026-10-17): a paid pickup the Store has not accepted yet. The guest has just paid and
 * watches for "Order accepted"; at the 15 s pace it appeared up to 15 s after the Store accepted.
 * Trade-off: one read every 5 s per waiting guest instead of every 15 s, only for the short window
 * between payment and acceptance (the Store accepts within minutes or the order is refunded), with
 * the same backoff on errors and no checks while the page is hidden. For one pilot Store that is a
 * handful of reads a minute; many concurrent waiting guests would want the live channel instead.
 */
export const orderAwaitingAcceptancePollIntervalMs = 5_000;
/** Longest wait between checks after repeated failures of a normally paced order. */
export const orderStatusPollErrorCapMs = 60_000;

/**
 * How the page re-reads an order: a just-received order, a paid pickup waiting for the Store, an
 * accepted order the kitchen is making and a ready pickup quickly, any other open order at the normal pace, and not at all once the order is
 * settled or live updates are on.
 */
export type OrderStatusPollMode =
  "received" | "awaiting-acceptance" | "preparing" | "awaiting-collection" | "active" | "stopped";
export interface OrderStatusPoll {
  readonly mode: OrderStatusPollMode;
  /** Checks that failed in a row since the last successful read. */
  readonly errors: number;
}
export const stoppedOrderStatusPoll: OrderStatusPoll = Object.freeze({
  mode: "stopped",
  errors: 0,
});

/** A pickup that is ready and not yet collected: the guest is waiting at the counter. */
export function isAwaitingCollection(view: OrderStatusView): boolean {
  return (
    view.order.orderType === "Pickup" &&
    !isOrderSettled(view) &&
    (view.order.canonicalPhase === "Ready" || kitchenStatus(view) === "Ready")
  );
}

/**
 * An accepted order whose food is still queued or being made: the next change the guest waits for
 * is "Ready". A dine-in round already served, or one waiting for payment, is not.
 *
 * WP-2423 (v15 2026-10-17): decided from the kitchen's own progress. In the pilot the order's
 * phase stays `Submitted` until it is collected (Ordering's status projection is advanced only by
 * Ordering's records), so a phase-only test never applied and the page kept its 15 s pace while
 * the kitchen made the order. A kitchen ticket exists only once the Store accepted the order; an
 * order still waiting for the Store (no ticket yet) keeps the normal pace.
 */
export function isInPreparation(view: OrderStatusView): boolean {
  if (isOrderSettled(view) || view.sources?.storeAcceptance !== undefined) return false;
  const kitchen = kitchenStatus(view);
  if (kitchen === "Preparing") return true;
  if (kitchen === "Queued") return view.sources?.kitchen != null;
  const phase = view.order.canonicalPhase;
  return kitchen === "Unknown" && (phase === "Accepted" || phase === "In Progress");
}

/**
 * WP-2423 (v15 2026-10-17): a paid pickup still waiting for the Store to accept it — a successful
 * payment, no kitchen ticket yet (`sources.kitchen` is null until the Store accepts) and no
 * not-accepted or Store-offline outcome. A pickup held while the Store is offline keeps the normal
 * pace: that wait can be long and the page already says the Store is offline.
 */
export function isAwaitingAcceptance(view: OrderStatusView): boolean {
  const sources = view.sources;
  return (
    view.order.orderType === "Pickup" &&
    !isOrderSettled(view) &&
    sources !== undefined &&
    sources.kitchen === null &&
    sources.storeAcceptance === undefined &&
    (sources.payments ?? []).some((payment) => payment.status === "Succeeded")
  );
}

/** The next polling state after the order status changed. */
export function advanceOrderStatusPoll(
  previous: OrderStatusPoll,
  state: OrderStatusState,
): OrderStatusPoll {
  switch (state.status) {
    case "received":
      return { mode: "received", errors: 0 };
    case "ready":
      return {
        mode:
          state.realtime === "available" || isOrderSettled(state.view)
            ? "stopped"
            : isAwaitingCollection(state.view)
              ? "awaiting-collection"
              : isInPreparation(state.view)
                ? "preparing"
                : isAwaitingAcceptance(state.view)
                  ? "awaiting-acceptance"
                  : "active",
        errors: 0,
      };
    // A check in flight keeps the current pace.
    case "loading":
      return previous;
    // A failed check while polling keeps trying, more slowly each time; a failed first load waits
    // for the guest's tap as before.
    case "unavailable":
      return previous.mode === "stopped"
        ? previous
        : { mode: previous.mode, errors: previous.errors + 1 };
    default:
      return stoppedOrderStatusPoll;
  }
}

/**
 * Milliseconds until the next check, or null for none. Failures double the wait, up to the normal
 * interval for the quick modes and up to a minute for the normal one; a success resets it.
 */
export function nextOrderStatusPollDelayMs(poll: OrderStatusPoll): number | null {
  const base =
    poll.mode === "received"
      ? orderReceivedPollIntervalMs
      : poll.mode === "awaiting-acceptance"
        ? orderAwaitingAcceptancePollIntervalMs
        : poll.mode === "awaiting-collection"
          ? orderAwaitingCollectionPollIntervalMs
          : poll.mode === "preparing"
            ? orderPreparingPollIntervalMs
            : poll.mode === "active"
              ? orderStatusPollIntervalMs
              : null;
  if (base === null) return null;
  const cap =
    base < orderStatusPollIntervalMs ? orderStatusPollIntervalMs : orderStatusPollErrorCapMs;
  return Math.min(base * 2 ** Math.min(poll.errors, 16), cap);
}

/**
 * Re-reads the order on the pace above while the page is visible, and once more whenever it becomes
 * visible again. Returns the stop function.
 */
export function startOrderStatusPolling(
  controller: OrderStatusController,
  environment: {
    readonly isVisible?: () => boolean;
    readonly onVisible?: (listener: () => void) => () => void;
  } = browserPollingEnvironment(),
): () => void {
  const visible = environment.isVisible ?? (() => true);
  let poll = advanceOrderStatusPoll(stoppedOrderStatusPoll, controller.getState());
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timerDelay: number | null = null;
  const schedule = () => {
    const delay = nextOrderStatusPollDelayMs(poll);
    // An unchanged pace keeps the running timer, like a fixed interval.
    if (timer !== null && delay === timerDelay) return;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    timerDelay = delay;
    if (delay !== null) timer = setTimeout(tick, delay);
  };
  const tick = () => {
    timer = null;
    if (visible()) void controller.refresh();
    schedule();
  };
  schedule();
  const unsubscribe = controller.subscribe(() => {
    poll = advanceOrderStatusPoll(poll, controller.getState());
    schedule();
  });
  const stopVisible = environment.onVisible?.(() => {
    if (poll.mode !== "stopped" && visible()) void controller.refresh();
  });
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    unsubscribe();
    stopVisible?.();
  };
}

function browserPollingEnvironment() {
  if (typeof document === "undefined") return {};
  return {
    isVisible: () => document.visibilityState === "visible",
    onVisible: (listener: () => void) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

/** WP-2423 Q6: why the store cancelled, in words for the customer (never internal codes). */
export const staffCancellationReasonText: Readonly<Record<StaffCancellationReason, string>> =
  orderStatusText.cancelReason;
export function staffRefundText(cancellation: StaffCancellation): string {
  return cancellation.refundStatus === "Refunded"
    ? orderStatusText.staffRefunded
    : orderStatusText.staffRefundPending;
}
/**
 * WP-2423 Q6 step 2: "Cancelled · Refund pending $4.52" next to an item the store cancelled.
 * WP-2423 (v15 8c4480dd L2): every cancelled item shows its own price with tax, the same way for
 * an item cancellation and a cancelled round; the tip share it returned is stated only in the
 * refund sentence below the items (the cancellation's refund amount includes it).
 */
export function itemCancellationText(
  cancellation: ItemCancellation,
  lineTotal: { readonly amountMinor: bigint; readonly currencyCode: string } | null,
): string {
  const amount =
    lineTotal === null ? "" : " " + formatMoney(lineTotal.amountMinor, lineTotal.currencyCode);
  return orderStatusText.itemCancelled(
    cancellation.refundStatus === "Refunded"
      ? orderStatusText.itemRefunded
      : orderStatusText.itemRefundPending,
    amount,
  );
}
/**
 * WP-2423 (46940b76 L4): an item of a round (or order) the store cancelled as a whole: "Cancelled ·
 * Refunded $5.63" — its price with tax, returned with the rest of the payment (the round's
 * remaining tip is stated in the refund sentence). Without a store refund (a round cancelled
 * unpaid, or an item already refunded before) only "Cancelled".
 */
export function storeCancelledItemText(
  cancellation: StaffCancellation | undefined,
  lineTotal: { readonly amountMinor: bigint; readonly currencyCode: string } | null,
): string {
  if (cancellation === undefined || lineTotal === null) return orderStatusText.itemCancelledLabel;
  return orderStatusText.itemCancelled(
    cancellation.refundStatus === "Refunded"
      ? orderStatusText.itemRefunded
      : orderStatusText.itemRefundPending,
    " " + formatMoney(lineTotal.amountMinor, lineTotal.currencyCode),
  );
}
/**
 * WP-2423 Q6 step 2: where the money for cancelled items is (tax and their tip share included).
 * WP-2423 (v15 8c4480dd L2): once the receipt states the refund, the sentence names the tip share
 * it returned, since the items above show only their price with tax.
 */
export function itemRefundSummary(
  cancellations: readonly ItemCancellation[],
  refunds: OrderRefunds["entries"] = [],
): string[] {
  const currency = cancellations[0]?.refundAmount.currencyCode;
  if (currency === undefined) return [];
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value) => b.includes(value));
  const sum = (status: ItemCancellation["refundStatus"]) => {
    const entries = cancellations.filter((entry) => entry.refundStatus === status);
    if (entries.length === 0) return null;
    const total = entries.reduce((sum, entry) => sum + entry.refundAmount.amountMinor, 0n);
    const tips = entries.map(
      (entry) =>
        refunds.find(
          (refund) =>
            refund.kind === "ItemCancellation" &&
            same(refund.orderItemReferences, entry.orderItemReferences),
        )?.tip.amountMinor,
    );
    return {
      amount: formatMoney(total, currency),
      tip: tips.every((tip) => tip !== undefined)
        ? tips.reduce<bigint>((sum, tip) => sum + (tip ?? 0n), 0n)
        : null,
    };
  };
  const refunded = sum("Refunded");
  const pending = sum("Pending");
  return [
    ...(refunded === null
      ? []
      : [
          refunded.tip === null
            ? orderStatusText.cancelledItemsRefunded(refunded.amount)
            : refunded.tip > 0n
              ? orderStatusText.cancelledItemsRefundedWithTip(
                  refunded.amount,
                  formatMoney(refunded.tip, currency),
                )
              : orderStatusText.cancelledItemsRefundedNoTip(refunded.amount),
        ]),
    ...(pending === null ? [] : [orderStatusText.cancelledItemsRefundPending(pending.amount)]),
  ];
}
/** WP-2423 Q6: the store cancelled the whole order (a pickup, or every dine-in round). */
export function staffCancelledOrder(view: OrderStatusView): StaffCancellation | null {
  const cancellations = view.sources?.staffCancellations ?? [];
  const cancelledAll = view.order.batches.every((batch) =>
    cancellations.some((entry) => entry.orderBatchReference === batch.orderBatchReference),
  );
  return (view.order.orderType === "Pickup" || cancelledAll) && cancellations.length > 0
    ? (cancellations[cancellations.length - 1] ?? null)
    : null;
}

export function isOrderSettled(view: OrderStatusView): boolean {
  const phase = view.order.canonicalPhase;
  return (
    // A dine-in Order whose items were all served is Fulfilled but the table can still order
    // another round (staff can enter one too), so the page keeps checking.
    (phase === "Fulfilled" && view.order.orderType !== "DineIn") ||
    phase === "Cancelled" ||
    phase === "Rejected" ||
    view.order.fulfillmentStatus === "Completed" ||
    Boolean(view.sources?.pickup?.notCollectedAt) ||
    Boolean(view.sources?.unpaidCancellation?.cancelledAt) ||
    (view.sources?.storeAcceptance?.state === "NotAccepted" &&
      view.sources.storeAcceptance.refundStatus === "Refunded") ||
    (view.order.orderType === "Pickup" && staffCancelledOrder(view) !== null)
  );
}

/**
 * WP-2423: dine-in rounds that will never reach the kitchen because their payment didn't go through
 * (already cancelled, or failed and about to be cancelled automatically).
 */
export function unpaidRounds(view: OrderStatusView): ReadonlySet<string> {
  return new Set([
    ...(view.sources?.unpaidCancellations?.map((entry) => entry.orderBatchReference) ?? []),
    ...(view.sources?.batchPayments
      ?.filter((entry) => entry.cancelsAt !== null)
      .map((entry) => entry.orderBatchReference) ?? []),
  ]);
}

/**
 * WP-2423: dine-in rounds still waiting for their payment. The kitchen only receives a round once it
 * is paid, so these are not "in the queue" (a failed or cancelled one is in unpaidRounds instead).
 */
export function awaitingPaymentRounds(view: OrderStatusView): ReadonlySet<string> {
  const ticketed = new Set(
    view.sources?.kitchen?.batches.map((batch) => batch.orderBatchReference) ?? [],
  );
  const notPaid = unpaidRounds(view);
  return new Set(
    view.sources?.batchPayments
      ?.filter(
        (entry) =>
          entry.status === "Awaiting" &&
          !notPaid.has(entry.orderBatchReference) &&
          !ticketed.has(entry.orderBatchReference),
      )
      .map((entry) => entry.orderBatchReference) ?? [],
  );
}

/**
 * WP-2423: how far a dine-in round has been served, from Dining's current served quantities. Items
 * the Store cancelled are not waiting to be served. Null when no serving facts are available.
 */
export function roundServing(
  view: OrderStatusView,
  batch: OrderStatusView["order"]["batches"][number],
): "All" | "Some" | "None" | null {
  const served = view.order.orderType === "DineIn" ? view.sources?.dining?.items : undefined;
  if (served === undefined) return null;
  const cancelled = new Set(
    view.sources?.itemCancellations?.flatMap((entry) => entry.orderItemReferences) ?? [],
  );
  const quantities = batch.items
    .filter((item) => !cancelled.has(item.orderItemReference))
    .map((item) => ({
      ordered: item.quantity,
      served:
        served.find(
          (entry) =>
            entry.orderBatchReference === batch.orderBatchReference &&
            entry.orderItemReference === item.orderItemReference,
        )?.servedQuantity ?? 0,
    }));
  if (quantities.length === 0) return null;
  if (quantities.every((entry) => entry.served >= entry.ordered)) return "All";
  return quantities.some((entry) => entry.served > 0) ? "Some" : "None";
}

/**
 * The kitchen's progress over the rounds still to be made (DEC-PILOT-BATCH-PHASE-01): cancelled,
 * unpaid and fully served rounds don't count, and a round waiting for payment hasn't reached it.
 */
function kitchenStatus(
  view: OrderStatusView,
): "Ready" | "Preparing" | "Queued" | "Unknown" | "Served" | "AwaitingPayment" {
  const kitchen = view.sources?.kitchen;
  if (!kitchen) return "Unknown";
  // WP-2423 Q6: a round the store cancelled is not waiting for the kitchen, nor is an unpaid one.
  const cancelled = new Set([
    ...(view.sources?.staffCancellations?.map((entry) => entry.orderBatchReference) ?? []),
    ...unpaidRounds(view),
  ]);
  const awaiting = awaitingPaymentRounds(view);
  const open = view.order.batches.filter(
    (batch) =>
      !cancelled.has(batch.orderBatchReference) && !awaiting.has(batch.orderBatchReference),
  );
  const remaining = open.filter((batch) => roundServing(view, batch) !== "All");
  if (remaining.length === 0)
    return awaiting.size > 0 ? "AwaitingPayment" : open.length > 0 ? "Served" : "Unknown";
  const expected = new Set(remaining.map((batch) => batch.orderBatchReference));
  const active = kitchen.batches.filter(
    (batch) => batch.status !== "Cancelled" && expected.has(batch.orderBatchReference),
  );
  if (active.length === 0) return "Queued";
  if (active.length === expected.size && active.every((batch) => batch.status === "Ready"))
    return "Ready";
  return active.some((batch) => batch.status !== "Queued") ? "Preparing" : "Queued";
}

/**
 * Everything paid for this order so far: every successful payment, one per round for a dine-in
 * order shared by the table (tips included). Refunds are stated separately on the page.
 */
export function paidTotal(
  view: OrderStatusView,
): { readonly amountMinor: bigint; readonly currencyCode: string } | null {
  const paid = (view.sources?.payments ?? []).flatMap((payment) =>
    payment.status === "Succeeded" && payment.amount ? [payment.amount] : [],
  );
  const currencyCode = paid[0]?.currencyCode;
  if (currencyCode === undefined) return null;
  return {
    amountMinor: paid
      .filter((amount) => amount.currencyCode === currencyCode)
      .reduce((sum, amount) => sum + amount.amountMinor, 0n),
    currencyCode,
  };
}

/**
 * WP-2423 (v15 3cd0f8dd H1): what was paid and how — a table can pay some rounds online and staff
 * take others on the store's card machine; both are this order's payments.
 */
export function paymentReceivedText(
  view: OrderStatusView,
  paid: { readonly amountMinor: bigint; readonly currencyCode: string },
): string {
  const succeeded = (view.sources?.payments ?? []).filter(
    (payment) =>
      payment.status === "Succeeded" &&
      payment.amount !== null &&
      payment.amount.currencyCode === paid.currencyCode,
  );
  const machine = succeeded
    .filter((payment) => payment.method === "CardMachine")
    .reduce((sum, payment) => sum + (payment.amount?.amountMinor ?? 0n), 0n);
  const total = formatMoney(paid.amountMinor, paid.currencyCode);
  if (machine === 0n) return orderStatusText.payment.received(total);
  if (machine === paid.amountMinor) return orderStatusText.payment.receivedMachine(total);
  return orderStatusText.payment.receivedBoth(
    total,
    formatMoney(paid.amountMinor - machine, paid.currencyCode),
    formatMoney(machine, paid.currencyCode),
  );
}

/**
 * WP-2423 (v15 3cd0f8dd M3): the confirmed refunds the page explains in its own words. Item
 * cancellations and whole-round refunds already say so where they happened; a refund staff made
 * (or an amount refunded without items) gets its own line, with any share of the tip it returned.
 */
export function refundLines(view: OrderStatusView, withItemCancellations = false): string[] {
  // WP-2423 (46940b76 L4): a whole round (or order) the store cancelled returns what was left of
  // it and of its tip; say how much of the tip. When the store cancelled the whole order, the
  // item-cancellation summary is not shown, so each item cancellation's refund is stated here too.
  return (view.sources?.refunds?.entries ?? [])
    .filter(
      (entry) =>
        entry.kind === "Refund" ||
        entry.kind === "Other" ||
        entry.kind === "RoundRefund" ||
        (withItemCancellations && entry.kind === "ItemCancellation"),
    )
    .map((entry) =>
      entry.tip.amountMinor > 0n
        ? orderStatusText.refundReturnedWithTip(
            formatMoney(entry.total.amountMinor, entry.total.currencyCode),
            formatMoney(entry.tip.amountMinor, entry.tip.currencyCode),
          )
        : orderStatusText.refundReturned(
            formatMoney(entry.total.amountMinor, entry.total.currencyCode),
          ),
    );
}

function StatusContent({
  view,
  pickupController,
}: {
  readonly view: OrderStatusView;
  readonly pickupController?: PickupCodeController | undefined;
}) {
  const complete =
    view.order.orderType === "Pickup" && view.order.fulfillmentStatus === "Completed";
  const notCollected =
    view.order.orderType === "Pickup" && !complete && Boolean(view.sources?.pickup?.notCollectedAt);
  const unpaidPickupCancelled =
    view.order.orderType === "Pickup" && Boolean(view.sources?.unpaidCancellation?.cancelledAt);
  const storeCancelled = staffCancelledOrder(view);
  // WP-2423 Q9-G1: not accepted in time (refunded automatically), or waiting after a store outage.
  const storeAcceptance =
    view.order.orderType === "Pickup" ? (view.sources?.storeAcceptance ?? null) : null;
  const notAccepted = storeAcceptance?.state === "NotAccepted" ? storeAcceptance : null;
  const awaitingStore = storeAcceptance?.state === "AwaitingStore";
  const staffCancellations = view.sources?.staffCancellations ?? [];
  const itemCancellations = view.sources?.itemCancellations ?? [];
  const cancelledItem = (orderItemReference: string) =>
    itemCancellations.find((entry) => entry.orderItemReferences.includes(orderItemReference));
  // WP-2423: rounds cancelled because their payment didn't go through, and failed ones about to be.
  const unpaidCancelled = new Set(
    view.sources?.unpaidCancellations?.map((entry) => entry.orderBatchReference) ?? [],
  );
  // WP-2423: rounds the Store cancelled before anyone paid read as such, not as a failed payment.
  const cancelledByStore = new Set(
    view.sources?.unpaidCancellations
      ?.filter((entry) => entry.byStore === true)
      .map((entry) => entry.orderBatchReference) ?? [],
  );
  const notPaid = unpaidRounds(view);
  const awaitingPayment = awaitingPaymentRounds(view);
  const failedPayment = (orderBatchReference: string) =>
    view.sources?.batchPayments?.find(
      (entry) => entry.orderBatchReference === orderBatchReference && entry.cancelsAt !== null,
    )?.cancelsAt ?? null;
  const kitchen = view.sources?.kitchen;
  const kitchenLabel = kitchenStatus(view);
  const diningItems = view.order.orderType === "DineIn" ? view.sources?.dining?.items : undefined;
  const allServed =
    diningItems !== undefined &&
    view.order.batches
      .filter(
        (batch) =>
          !staffCancellations.some(
            (entry) => entry.orderBatchReference === batch.orderBatchReference,
          ) && !notPaid.has(batch.orderBatchReference),
      )
      .every((batch) =>
        batch.items.every(
          (item) =>
            // WP-2423 Q6 step 2: a cancelled item is not waiting to be served.
            cancelledItem(item.orderItemReference) !== undefined ||
            diningItems.some(
              (served) =>
                served.orderBatchReference === batch.orderBatchReference &&
                served.orderItemReference === item.orderItemReference &&
                served.servedQuantity === item.quantity,
            ),
        ),
      );
  const someServed = diningItems?.some((item) => item.servedQuantity > 0) === true;
  // WP-2423 Q26: the kitchen is making part of the order again (dropped, made wrong, sent back).
  const remakes = view.sources?.remakes ?? [];
  const remaking = (orderItemReference: string) =>
    remakes.find((entry) => entry.orderItemReference === orderItemReference);
  const pickup = view.order.orderType === "Pickup";
  // Handoff Section 24.3: the order's own phase when no finer source (kitchen, serving) says more.
  // A queued kitchen ticket means the store has the order but hasn't started on it.
  const stage =
    kitchenLabel === "Ready" ||
    (kitchenLabel === "Unknown" && view.order.canonicalPhase === "Ready")
      ? "Ready"
      : kitchenLabel === "Preparing" ||
          (kitchenLabel === "Unknown" && view.order.canonicalPhase === "In Progress")
        ? "Preparing"
        : view.order.canonicalPhase === "Submitted"
          ? "Submitted"
          : "Accepted";
  const progress = orderStatusText.progress;
  const [progressHeading, progressMessage] = storeCancelled
    ? [progress.storeCancelledHeading, staffCancellationReasonText[storeCancelled.reason]]
    : notAccepted
      ? [
          progress.notAcceptedHeading,
          notAccepted.refundStatus === "Refunded"
            ? progress.notAcceptedRefunded
            : progress.notAcceptedRefunding,
        ]
      : awaitingStore
        ? [progress.awaitingStoreHeading, progress.awaitingStore]
        : unpaidPickupCancelled
          ? [progress.cancelledHeading, progress.unpaidPickupCancelled]
          : complete
            ? [progress.collectedHeading, progress.collected]
            : // A pickup the store closed as not collected is reported as Cancelled; say why.
              notCollected
              ? [progress.notCollectedHeading, progress.notCollected]
              : view.order.canonicalPhase === "Cancelled"
                ? [progress.cancelledHeading, progress.cancelled]
                : view.order.canonicalPhase === "Rejected"
                  ? [progress.notAcceptedHeading, progress.rejected]
                  : remakes.length > 0
                    ? pickup
                      ? [progress.remakingPickupHeading, progress.remakingPickup]
                      : [progress.remakingDineInHeading, progress.remakingDineIn]
                    : allServed
                      ? [progress.servedHeading, progress.served]
                      : view.order.canonicalPhase === "Fulfilled"
                        ? pickup
                          ? [progress.completeHeading, progress.complete]
                          : // Dine-in: everything was served; the table may still order more.
                            [progress.servedHeading, progress.served]
                        : kitchenLabel === "AwaitingPayment"
                          ? [
                              progress.awaitingPaymentHeading,
                              someServed
                                ? progress.awaitingPaymentSomeServed
                                : progress.awaitingPayment,
                            ]
                          : someServed
                            ? [progress.servingHeading, progress.serving]
                            : stage === "Ready"
                              ? pickup
                                ? [progress.readyPickupHeading, progress.readyPickup]
                                : [progress.readyDineInHeading, progress.readyDineIn]
                              : stage === "Preparing"
                                ? [progress.preparingHeading, progress.preparing]
                                : stage === "Accepted"
                                  ? [
                                      progress.acceptedHeading,
                                      pickup ? progress.acceptedPickup : progress.acceptedDineIn,
                                    ]
                                  : [progress.submittedHeading, progress.submitted];
  const payments = view.sources?.payments;
  const paid = paidTotal(view);
  const refunded = view.sources?.refunds?.refunded ?? null;
  // WP-2423 (v15 3cd0f8dd M3): items a refund returned (staff refunds, rounds refunded in full).
  const refundedItems = new Set(
    (view.sources?.refunds?.entries ?? [])
      .filter((entry) => entry.kind === "Refund" || entry.kind === "RoundRefund")
      .flatMap((entry) => entry.orderItemReferences),
  );
  // WP-2423 (46940b76 L4): items partly or wholly refunded before their round was cancelled (their
  // line price is no longer what the cancellation returned for them).
  const refundedBefore = new Set(
    (view.sources?.refunds?.entries ?? [])
      .filter((entry) => entry.kind === "Refund")
      .flatMap((entry) => entry.orderItemReferences),
  );
  const paymentLabel =
    payments == null
      ? // No payment result could be read for this order: say nothing rather than guess.
        null
      : paid && storeCancelled
        ? // WP-2423 Q6: a store-cancelled order says where the money is, not that it was received.
          (storeCancelled.refundStatus === "Refunded"
            ? orderStatusText.payment.refunded
            : orderStatusText.payment.refundPending)(
            formatMoney(paid.amountMinor, paid.currencyCode),
          )
        : paid && notAccepted
          ? (notAccepted.refundStatus === "Refunded"
              ? orderStatusText.payment.refunded
              : orderStatusText.payment.refundPending)(
              formatMoney(paid.amountMinor, paid.currencyCode),
            )
          : paid
            ? paymentReceivedText(view, paid)
            : unpaidPickupCancelled
              ? orderStatusText.payment.notPaid
              : payments.some((payment) => payment.status === "Failed")
                ? orderStatusText.payment.attemptFailed
                : orderStatusText.payment.pending;
  // The kitchen has no ticket for this order yet: the order is in, preparation hasn't started.
  // Once the order has ended (cancelled, not paid, collected, closed) the row says nothing useful.
  const orderEnded =
    view.order.canonicalPhase === "Cancelled" ||
    view.order.canonicalPhase === "Rejected" ||
    view.order.canonicalPhase === "Fulfilled" ||
    complete ||
    notCollected ||
    unpaidPickupCancelled ||
    view.order.batches.every((batch) => notPaid.has(batch.orderBatchReference));
  const kitchenWords = orderStatusText.kitchen;
  const kitchenText =
    storeCancelled || notAccepted
      ? kitchenWords.cancelled
      : remakes.length > 0 && !complete
        ? kitchenWords.remaking
        : kitchenLabel === "Unknown"
          ? orderEnded
            ? null
            : view.order.canonicalPhase === "Ready"
              ? kitchenWords.ready
              : view.order.canonicalPhase === "In Progress"
                ? kitchenWords.preparing
                : kitchenWords.notStarted
          : kitchenLabel === "Queued"
            ? kitchenWords.inQueue
            : kitchenLabel === "AwaitingPayment"
              ? kitchenWords.awaitingPayment
              : kitchenLabel === "Served"
                ? kitchenWords.done
                : kitchenLabel === "Ready"
                  ? kitchenWords.ready
                  : kitchenWords.preparing;
  const multipleBatches = view.order.batches.length > 1;
  // WP-2423: a round whose payment didn't go through is never charged (cancelled, or about to be).
  const summary = orderMoneySummary(view, (reference) => !notPaid.has(reference));
  const itemDetails = new Map(
    (view.sources?.itemPrices ?? []).map((price) => [price.orderItemReference, price] as const),
  );
  const currency = view.order.batches[0]?.items[0]?.lineTotal.currencyCode ?? "CAD";
  return (
    <>
      <section
        className="order-status__card order-status__summary"
        aria-labelledby="order-progress-heading"
      >
        <p className="bop-eyebrow">{orderStatusText.orderEyebrow(view.order.orderNumber)}</p>
        <h2 id="order-progress-heading">{progressHeading}</h2>
        <p>{progressMessage}</p>
        {storeCancelled ? (
          <p className="order-status__refund">{staffRefundText(storeCancelled)}</p>
        ) : null}
        <dl>
          <div>
            <dt>{orderStatusText.orderTypeLabel}</dt>
            <dd>
              {view.order.orderType === "DineIn"
                ? orderStatusText.orderTypeDineIn
                : orderStatusText.orderTypePickup}
            </dd>
          </div>
          {kitchenText === null ? null : (
            <div>
              <dt>{orderStatusText.kitchenStatusLabel}</dt>
              <dd>{kitchenText}</dd>
            </div>
          )}
          {paymentLabel === null ? null : (
            <div>
              <dt>{orderStatusText.paymentLabel}</dt>
              <dd>{paymentLabel}</dd>
            </div>
          )}
          {/* WP-2423 (v15 3cd0f8dd M3): confirmed refunds, as the receipt states them. A whole
              store cancellation's payment line already says the payment was refunded. */}
          {refunded && !storeCancelled && !notAccepted ? (
            <div>
              <dt>{orderStatusText.refundedLabel}</dt>
              <dd>{formatMoney(refunded.amountMinor, refunded.currencyCode)}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      {view.order.orderType === "Pickup" &&
      !complete &&
      !notCollected &&
      !unpaidPickupCancelled &&
      !storeCancelled &&
      !notAccepted ? (
        <PickupCodePanel
          orderReference={view.order.orderReference}
          orderNumber={view.order.orderNumber}
          controller={pickupController}
          autoReveal={kitchenLabel === "Ready" || view.order.canonicalPhase === "Ready"}
          remaking={remakes.length > 0}
          refreshToken={view.sources?.checkedAt ?? view.projectedAt}
        />
      ) : null}

      {payments && payments.some((payment) => payment.freshnessStatus !== "Fresh") ? (
        <section className="order-status__warning" role="status">
          <h2>{orderStatusText.paymentDelayedHeading}</h2>
          <p>{orderStatusText.paymentDelayed}</p>
        </section>
      ) : null}

      {view.freshnessStatus !== "Fresh" ? (
        <section className="order-status__warning" role="status">
          <h2>{orderStatusText.statusDelayedHeading}</h2>
          <p>
            {view.freshnessStatus === "Rebuilding"
              ? orderStatusText.statusRebuilding
              : view.freshnessStatus === "Failed"
                ? orderStatusText.statusFailed
                : orderStatusText.statusStale}
          </p>
        </section>
      ) : null}

      <section className="order-status__batches" aria-labelledby="order-items-heading">
        <h2 id="order-items-heading">
          {view.order.orderType === "DineIn"
            ? orderStatusText.tableItemsHeading
            : orderStatusText.itemsHeading}
        </h2>
        {view.order.orderType === "DineIn" ? (
          <p className="order-status__table-note">{orderStatusText.tableItemsNote}</p>
        ) : null}
        {view.order.batches.map((batch, index) => {
          const batchKitchen = kitchen?.batches.find(
            (entry) => entry.orderBatchReference === batch.orderBatchReference,
          );
          const batchCancellation =
            storeCancelled === null || multipleBatches
              ? staffCancellations.find(
                  (entry) => entry.orderBatchReference === batch.orderBatchReference,
                )
              : undefined;
          return (
            <article
              key={batch.orderBatchReference}
              className="order-status__card order-status__batch"
            >
              {multipleBatches ? <h3>{orderStatusText.roundHeading(index + 1)}</h3> : null}
              {unpaidCancelled.has(batch.orderBatchReference) ? (
                <p className="order-status__batch-cancelled">
                  {cancelledByStore.has(batch.orderBatchReference)
                    ? multipleBatches
                      ? orderStatusText.roundCancelledByStoreUnpaid
                      : orderStatusText.orderCancelledByStoreUnpaid
                    : multipleBatches
                      ? orderStatusText.roundCancelledUnpaid
                      : orderStatusText.orderCancelledUnpaid}
                </p>
              ) : failedPayment(batch.orderBatchReference) !== null ? (
                <p className="order-status__warning" role="status">
                  {multipleBatches
                    ? orderStatusText.roundPaymentFailed
                    : orderStatusText.orderPaymentFailed}
                  {orderStatusText.cancelsAt(
                    endSentence(formatClockTime(failedPayment(batch.orderBatchReference) ?? "")),
                  )}
                </p>
              ) : batchCancellation ? (
                <p className="order-status__batch-cancelled">
                  {multipleBatches
                    ? orderStatusText.roundCancelledByStore
                    : orderStatusText.orderCancelledByStore}
                  {staffCancellationReasonText[batchCancellation.reason]}{" "}
                  {staffRefundText(batchCancellation)}
                </p>
              ) : multipleBatches && awaitingPayment.has(batch.orderBatchReference) ? (
                <p>{orderStatusText.roundAwaitingPayment}</p>
              ) : multipleBatches && roundServing(view, batch) === "All" ? (
                <p>{orderStatusText.roundServed}</p>
              ) : multipleBatches && roundServing(view, batch) === "Some" ? (
                <p>{orderStatusText.roundPartlyServed}</p>
              ) : kitchen && multipleBatches ? (
                <p>
                  {batchKitchen?.status === "Ready"
                    ? kitchenWords.ready
                    : batchKitchen?.status === "InProgress"
                      ? kitchenWords.preparing
                      : batchKitchen
                        ? kitchenWords.inQueue
                        : kitchenWords.notStarted}
                </p>
              ) : null}
              <ul>
                {batch.items.map((item) => {
                  const itemCancellation = cancelledItem(item.orderItemReference);
                  // WP-2423 Q6: a round the store cancelled as a whole marks every remaining line.
                  const batchCancelled =
                    itemCancellation === undefined &&
                    (unpaidCancelled.has(batch.orderBatchReference) ||
                      staffCancellations.some(
                        (entry) => entry.orderBatchReference === batch.orderBatchReference,
                      ));
                  return (
                    <li
                      key={item.orderItemReference}
                      className={
                        itemCancellation || batchCancelled
                          ? "order-status__item--cancelled"
                          : undefined
                      }
                    >
                      <span className="order-status__item-name">
                        {item.quantity} × {item.displayName}
                        {/* WP-2423: the options chosen (with what each added) and the guest's note. */}
                        {itemDetails.get(item.orderItemReference)?.options?.length ? (
                          <span className="order-status__item-options">
                            {itemDetails
                              .get(item.orderItemReference)
                              ?.options?.map(describeChosenOption)
                              .join(listSeparator())}
                          </span>
                        ) : null}
                        {itemDetails.get(item.orderItemReference)?.customerNote ? (
                          <span className="order-status__item-note">
                            {commonText.notePrefix}{" "}
                            {itemDetails.get(item.orderItemReference)?.customerNote}
                          </span>
                        ) : null}
                      </span>
                      <span className="order-status__item-amount">
                        {formatMoney(
                          summary.itemAmount(item.orderItemReference, item.lineTotal.amountMinor),
                          item.lineTotal.currencyCode,
                        )}
                      </span>
                      {itemCancellation ? (
                        <span className="order-status__item-cancelled">
                          {itemCancellationText(
                            itemCancellation,
                            refundedBefore.has(item.orderItemReference) ? null : item.lineTotal,
                          )}
                        </span>
                      ) : batchCancelled ? (
                        <span className="order-status__item-cancelled">
                          {storeCancelledItemText(
                            staffCancellations.find(
                              (entry) => entry.orderBatchReference === batch.orderBatchReference,
                            ),
                            unpaidCancelled.has(batch.orderBatchReference) ||
                              refundedBefore.has(item.orderItemReference)
                              ? null
                              : item.lineTotal,
                          )}
                        </span>
                      ) : notPaid.has(batch.orderBatchReference) ? (
                        <span className="order-status__item-cancelled">
                          {orderStatusText.itemNotPaid}
                        </span>
                      ) : refundedItems.has(item.orderItemReference) ? (
                        <span className="order-status__item-refunded">
                          {orderStatusText.itemRefundedTag}
                        </span>
                      ) : remaking(item.orderItemReference) && !complete ? (
                        <span className="order-status__item-remake">
                          {orderStatusText.itemBeingRemade}
                        </span>
                      ) : view.sources?.dining ? (
                        <span>
                          {orderStatusText.itemServedOf(
                            view.sources.dining.items.find(
                              (entry) =>
                                entry.orderItemReference === item.orderItemReference &&
                                entry.orderBatchReference === batch.orderBatchReference,
                            )?.servedQuantity,
                            item.quantity,
                          )}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </article>
          );
        })}
        {summary.subtotal === null && summary.tip === 0n ? null : (
          <dl className="order-status__money">
            {summary.subtotal === null ? null : (
              <div>
                <dt>{commonText.subtotal}</dt>
                <dd>{formatMoney(summary.subtotal, currency)}</dd>
              </div>
            )}
            {summary.adjustments !== null && summary.adjustments !== 0n ? (
              <div>
                <dt>{orderStatusText.discountsAndFees}</dt>
                <dd>{formatMoney(summary.adjustments, currency)}</dd>
              </div>
            ) : null}
            {summary.subtotal === null ? null : (
              <div>
                <dt>{commonText.tax}</dt>
                <dd>{formatMoney(summary.tax ?? 0n, currency)}</dd>
              </div>
            )}
            {summary.tip === 0n ? null : (
              <div>
                <dt>{commonText.tip}</dt>
                <dd>{formatMoney(summary.tip, currency)}</dd>
              </div>
            )}
          </dl>
        )}
        <p className="order-status__total">
          <span>
            {summary.subtotal !== null
              ? commonText.total
              : summary.tip === 0n
                ? orderStatusText.totalIncludingTax
                : orderStatusText.totalIncludingTaxAndTip}
          </span>
          <span>{formatMoney(summary.total, currency)}</span>
        </p>
        {notPaid.size > 0 ? (
          <p className="order-status__item-refund">{orderStatusText.unpaidRoundsExcluded}</p>
        ) : null}
        {/* A whole store cancellation states its own full refund; the item note would contradict it. */}
        {(storeCancelled
          ? []
          : itemRefundSummary(itemCancellations, view.sources?.refunds?.entries)
        ).map((line) => (
          <p key={line} className="order-status__item-refund">
            {line}
          </p>
        ))}
        {(notAccepted ? [] : refundLines(view, storeCancelled !== null)).map((line, index) => (
          <p key={`refund-${index}`} className="order-status__item-refund">
            {line}
          </p>
        ))}
      </section>
    </>
  );
}

/**
 * WP-2423 Q10: the browser no longer holds this visit (it expired, the table closed, or the app was
 * opened somewhere else). Say so plainly and give the way back instead of "access denied".
 */
export function VisitEndedNotice({ orderReference }: { readonly orderReference?: string }) {
  return (
    <section className="order-status__card order-status__visit-ended" role="alert">
      <h2>{orderStatusText.visitEnded.heading}</h2>
      {/* WP-2423 (v15 3cd0f8dd M5): the receipt stays readable on this phone for a while. */}
      {orderReference ? (
        <>
          <p>{orderStatusText.visitEnded.receipt}</p>
          <Link className="order-status__retry" to={`/orders/${orderReference}/receipt`}>
            {orderStatusText.visitEnded.viewReceipt}
          </Link>
        </>
      ) : null}
      <p>{orderStatusText.visitEnded.atTable}</p>
      <p>{orderStatusText.visitEnded.pickup}</p>
      <Link className="order-status__retry" to="/">
        {orderStatusText.visitEnded.start}
      </Link>
    </section>
  );
}

export function OrderStatusPage({
  controller: provided,
  pickupController,
  store,
  contactRemoval,
}: {
  readonly controller?: OrderStatusController;
  readonly pickupController?: PickupCodeController | undefined;
  readonly store?: CustomerStoreContext | undefined;
  /** WP-2423 Q16: removes the customer's own contact details (absent: no removal button). */
  readonly contactRemoval?: ContactRemovalClient | undefined;
}) {
  const { orderReference = "" } = useParams();
  const [controller] = useState(
    () =>
      provided ?? createOrderStatusController(orderReference, createUnavailableOrderStatusClient()),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  // WP-2423 (46940b76 L5): whether this browser had a visit when the page opened.
  const [openedWithVisit] = useState(() => getCustomerCsrfCredential() !== null);
  // Owner 2026-10-23: item names come from the Store in the chosen language.
  useReloadOnLanguageChange(() => void controller.refresh());
  useEffect(() => {
    void controller.load();
    const offline = () => controller.setOnline(false);
    const online = () => controller.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
      controller.dispose();
    };
  }, [controller]);
  const view = state.status === "ready" || state.status === "offline" ? state.view : null;
  // Registered after the load effect so a remount's dispose doesn't drop the polling listener.
  useEffect(() => startOrderStatusPolling(controller), [controller]);
  return (
    <CustomerPage
      step="order"
      store={store}
      orderReference={orderReference}
      className="order-status"
    >
      <header className="customer-heading">
        <p className="bop-eyebrow">{orderStatusText.pageEyebrow}</p>
        <h2>{orderStatusText.pageHeading}</h2>
      </header>

      {state.status === "loading" ? (
        <section role="status">
          <h2>{orderStatusText.loadingHeading}</h2>
        </section>
      ) : null}
      {state.status === "received" ? (
        // WP-2423 (v15 2026-10-16): the order is in; its progress shows here within seconds.
        <section className="order-status__received" role="status">
          <h2>{orderStatusText.receivedHeading}</h2>
          <p>{orderStatusText.received(state.received.orderNumber)}</p>
          <p>{orderStatusText.receivedNoChange}</p>
        </section>
      ) : null}
      {state.status === "invalid-reference" ? (
        <section role="alert">
          <h2>{orderStatusText.invalidHeading}</h2>
          <p>{orderStatusText.invalid}</p>
        </section>
      ) : null}
      {state.status === "permission-denied" ? (
        // WP-2423 (46940b76 L5): a browser that had a visit when the page opened (it ended
        // meanwhile), or whose ended visit placed this order, is told its visit ended (with its
        // receipt); any other browser is told plainly the order isn't available here.
        openedWithVisit || getEndedVisitReceiptAccess(orderReference) !== null ? (
          <VisitEndedNotice orderReference={orderReference} />
        ) : (
          <section className="order-status__card order-status__visit-ended" role="alert">
            <h2>{orderStatusText.notThisPhone.heading}</h2>
            <p>{orderStatusText.notThisPhone.body}</p>
            <Link className="order-status__retry" to="/">
              {orderStatusText.notThisPhone.start}
            </Link>
          </section>
        )
      ) : null}
      {state.status === "table-order" ? (
        <section className="order-status__card order-status__visit-ended" role="alert">
          <h2>{orderStatusText.tableOrder.heading}</h2>
          <p>{orderStatusText.tableOrder.body}</p>
          <Link className="order-status__retry" to="/dine-in/session">
            {orderStatusText.tableOrder.seeTable}
          </Link>
        </section>
      ) : null}
      {state.status === "not-found" ? (
        // WP-2423 (f5ae43a5 low): a signed-in guest who did not place this order (another table's
        // guest) gets the same plain answer as a new phone. A guest who just paid is answered
        // "Order received" by the server until the status is ready, so this is never their case.
        <section className="order-status__card order-status__visit-ended" role="alert">
          <h2>{orderStatusText.notThisPhone.heading}</h2>
          <p>{orderStatusText.notThisPhone.body}</p>
          <Link className="order-status__retry" to="/">
            {orderStatusText.notThisPhone.start}
          </Link>
        </section>
      ) : null}
      {state.status === "feature-disabled" ? (
        <section role="alert">
          <h2>{orderStatusText.disabledHeading}</h2>
        </section>
      ) : null}
      {state.status === "unavailable" ? (
        <section className="order-status__unavailable" role="alert">
          <span className="order-status__unavailable-icon" aria-hidden="true">
            !
          </span>
          <h2>{orderStatusText.unavailableHeading}</h2>
          <p>{orderStatusText.unavailable}</p>
          <button
            className="order-status__retry"
            type="button"
            onClick={() => void controller.refresh()}
          >
            {orderStatusText.tryLoadingStatus}
          </button>
        </section>
      ) : null}
      {state.status === "offline" ? (
        <section role="status" className="order-status__warning">
          <h2>{commonText.offlineHeading}</h2>
          <p>
            {view ? orderStatusText.offlineShowingLast : orderStatusText.offlineConnect}{" "}
            {orderStatusText.offlineReconnect}
          </p>
          <button
            className="order-status__retry"
            type="button"
            onClick={() => void controller.refresh()}
          >
            {orderStatusText.tryLoadingStatus}
          </button>
        </section>
      ) : null}
      {view ? <StatusContent view={view} pickupController={pickupController} /> : null}
      {state.status === "ready" ? (
        <section className="order-status__actions" aria-label={orderStatusText.updatesLabel}>
          <p>
            {state.realtime === "available"
              ? orderStatusText.liveUpdatesOn
              : isOrderSettled(state.view)
                ? orderStatusText.orderComplete
                : orderStatusText.checksEveryFewSeconds}
          </p>
          <button
            type="button"
            disabled={state.refreshing}
            onClick={() => void controller.refresh()}
          >
            {state.refreshing ? orderStatusText.refreshing : orderStatusText.refreshNow}
          </button>
        </section>
      ) : null}
      {view?.sources?.storeContact ? (
        <StoreContactCard contact={view.sources.storeContact} storeName={store?.storeName} />
      ) : null}
      {view && state.status === "ready" ? (
        <ContactDetailsSection
          orderReference={view.order.orderReference}
          contactDetails={view.sources?.contactDetails}
          privacyNoticeUrl={view.sources?.privacyNoticeUrl}
          storeName={store?.storeName}
          client={contactRemoval}
          onChanged={() => void controller.refresh()}
        />
      ) : null}
      {view?.order.orderType === "DineIn" ? (
        // WP-2423 Q8: every round at the table, including other guests', and what is still due.
        <Link className="order-status__receipt" to="/dine-in/session">
          {orderStatusText.seeTableOrders}
        </Link>
      ) : null}
      {view ? (
        <Link className="order-status__receipt" to={`/orders/${view.order.orderReference}/receipt`}>
          {orderStatusText.viewReceipt}
        </Link>
      ) : null}
      <Link className="order-status__back" to="/menu">
        {orderStatusText.backToMenu}
      </Link>
    </CustomerPage>
  );
}
