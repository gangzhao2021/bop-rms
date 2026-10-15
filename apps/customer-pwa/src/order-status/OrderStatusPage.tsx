import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import {
  createOrderStatusController,
  createUnavailableOrderStatusClient,
  type OrderStatusController,
} from "./order-status-controller.js";
import type {
  ItemCancellation,
  OrderStatusView,
  StaffCancellation,
  StaffCancellationReason,
} from "./types.js";
import { PickupCodePanel } from "../pickup-code/PickupCodePanel.js";
import type { PickupCodeController } from "../pickup-code/pickup-code-controller.js";
import { CustomerPage, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { endSentence, formatClockTime, formatMoney } from "../journey/format.js";
import { StoreContactCard } from "../journey/StoreContact.js";
import { ContactDetailsSection } from "./ContactDetailsSection.js";
import type { ContactRemovalClient } from "./contact-removal-client.js";

/** How often an active order re-reads its status when no live connection is available. */
export const orderStatusPollIntervalMs = 15_000;

/** WP-2423 Q6: why the store cancelled, in words for the customer (never internal codes). */
export const staffCancellationReasonText: Readonly<Record<StaffCancellationReason, string>> = {
  CustomerRequest: "The store cancelled it at your request.",
  SoldOut: "An item you ordered sold out.",
  StoreError: "The store couldn't prepare it.",
  DuplicateOrder: "It was a duplicate of another order.",
};
export function staffRefundText(cancellation: StaffCancellation): string {
  return cancellation.refundStatus === "Refunded"
    ? "Your payment was refunded in full."
    : "Refund pending — your payment is being returned in full.";
}
/**
 * WP-2423 Q6 step 2: "Cancelled · Refund pending $4.52" next to an item the store cancelled. The
 * amount is shown when the cancellation covers only this item (the refund is per cancellation).
 */
export function itemCancellationText(cancellation: ItemCancellation): string {
  const amount =
    cancellation.orderItemReferences.length === 1
      ? " " +
        formatMoney(cancellation.refundAmount.amountMinor, cancellation.refundAmount.currencyCode)
      : "";
  return (
    "Cancelled · " +
    (cancellation.refundStatus === "Refunded" ? "Refunded" : "Refund pending") +
    amount
  );
}
/** WP-2423 Q6 step 2: where the money for cancelled items is (tax included, tip not refunded). */
export function itemRefundSummary(cancellations: readonly ItemCancellation[]): string[] {
  const currency = cancellations[0]?.refundAmount.currencyCode;
  if (currency === undefined) return [];
  const sum = (status: ItemCancellation["refundStatus"]) => {
    const entries = cancellations.filter((entry) => entry.refundStatus === status);
    return entries.length === 0
      ? null
      : formatMoney(
          entries.reduce((total, entry) => total + entry.refundAmount.amountMinor, 0n),
          currency,
        );
  };
  const refunded = sum("Refunded");
  const pending = sum("Pending");
  return [
    ...(refunded === null
      ? []
      : [
          `Cancelled items: ${refunded} refunded to your original payment (tax included, tip not refunded).`,
        ]),
    ...(pending === null
      ? []
      : [
          `Cancelled items: a refund of ${pending} to your original payment is pending (tax included, tip not refunded).`,
        ]),
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
    phase === "Fulfilled" ||
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

function kitchenStatus(view: OrderStatusView): "Ready" | "Preparing" | "Queued" | "Unknown" {
  const kitchen = view.sources?.kitchen;
  if (!kitchen) return "Unknown";
  // WP-2423 Q6: a round the store cancelled is not waiting for the kitchen, nor is an unpaid one.
  const cancelled = new Set([
    ...(view.sources?.staffCancellations?.map((entry) => entry.orderBatchReference) ?? []),
    ...unpaidRounds(view),
  ]);
  const active = kitchen.batches.filter(
    (batch) => batch.status !== "Cancelled" && !cancelled.has(batch.orderBatchReference),
  );
  const expected = view.order.batches.filter(
    (batch) => !cancelled.has(batch.orderBatchReference),
  ).length;
  if (active.length === 0) return expected === 0 ? "Unknown" : "Queued";
  if (active.length === expected && active.every((batch) => batch.status === "Ready"))
    return "Ready";
  return active.some((batch) => batch.status !== "Queued") ? "Preparing" : "Queued";
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
  const notPaid = unpaidRounds(view);
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
  const [progressHeading, progressMessage] = storeCancelled
    ? ["Order cancelled by the store", staffCancellationReasonText[storeCancelled.reason]]
    : notAccepted
      ? [
          "Order not accepted",
          notAccepted.refundStatus === "Refunded"
            ? "The store couldn't accept your order, so your payment was refunded to your original payment method."
            : "The store couldn't accept your order, so your payment is being refunded to your original payment method.",
        ]
      : awaitingStore
        ? [
            "Waiting for the store",
            "The store hasn't confirmed your order yet. Please wait or contact the store.",
          ]
        : unpaidPickupCancelled
          ? [
              "Order cancelled",
              "Payment wasn't completed within 30 minutes, so this order was cancelled. If a payment still goes through, it will be refunded automatically.",
            ]
          : view.order.canonicalPhase === "Cancelled"
            ? ["Order cancelled", "Your order has been cancelled."]
            : view.order.canonicalPhase === "Rejected"
              ? ["Order not accepted", "Your order was not accepted."]
              : complete
                ? ["Order collected", "Your order has been collected. Enjoy!"]
                : notCollected
                  ? [
                      "Not collected",
                      "The store closed this pickup after the pickup time ended. Contact the store about your order or a refund.",
                    ]
                  : remakes.length > 0
                    ? view.order.orderType === "Pickup"
                      ? [
                          "Remaking part of your order",
                          "We're remaking part of your order. We'll have it ready shortly — please wait before collecting it.",
                        ]
                      : [
                          "Remaking an item",
                          "We're remaking an item for you. It will be brought to your table shortly.",
                        ]
                    : allServed
                      ? ["Items served", "All listed items have been served."]
                      : someServed
                        ? [
                            "Serving your order",
                            "Some items have been served. Check the remaining items below.",
                          ]
                        : kitchenLabel === "Ready"
                          ? view.order.orderType === "Pickup"
                            ? [
                                "Ready for pickup",
                                "Your order is ready. Show your pickup code at the counter.",
                              ]
                            : ["Kitchen preparation complete", "All listed batches are ready."]
                          : kitchenLabel === "Preparing"
                            ? ["Preparing your order", "The kitchen is preparing your order."]
                            : ["Order submitted", "We have your order."];
  const payments = view.sources?.payments;
  const paid = payments?.find((payment) => payment.status === "Succeeded" && payment.amount);
  const paymentLabel =
    payments == null
      ? // No payment result could be read for this order: say nothing rather than guess.
        null
      : paid?.amount && storeCancelled
        ? // WP-2423 Q6: a store-cancelled order says where the money is, not that it was received.
          (storeCancelled.refundStatus === "Refunded" ? "Refunded " : "Refund pending · ") +
          formatMoney(paid.amount.amountMinor, paid.amount.currencyCode)
        : paid?.amount && notAccepted
          ? (notAccepted.refundStatus === "Refunded" ? "Refunded " : "Refund pending · ") +
            formatMoney(paid.amount.amountMinor, paid.amount.currencyCode)
          : paid?.amount
            ? `Payment received ${formatMoney(paid.amount.amountMinor, paid.amount.currencyCode)}`
            : unpaidPickupCancelled
              ? "Not paid"
              : payments.some((payment) => payment.status === "Failed")
                ? "Payment attempt failed"
                : "Payment pending";
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
  const kitchenText =
    storeCancelled || notAccepted
      ? "Cancelled"
      : remakes.length > 0 && !complete
        ? "Remaking an item"
        : kitchenLabel === "Unknown"
          ? orderEnded
            ? null
            : view.order.canonicalPhase === "Ready"
              ? "Ready"
              : view.order.canonicalPhase === "In Progress"
                ? "Preparing"
                : "Not started yet"
          : kitchenLabel === "Queued"
            ? "In the queue"
            : kitchenLabel;
  const multipleBatches = view.order.batches.length > 1;
  // WP-2423: a round whose payment didn't go through is never charged (cancelled, or about to be).
  const total = view.order.batches
    .filter((batch) => !notPaid.has(batch.orderBatchReference))
    .flatMap((batch) => batch.items)
    .reduce((sum, item) => sum + item.lineTotal.amountMinor, 0n);
  const currency = view.order.batches[0]?.items[0]?.lineTotal.currencyCode ?? "CAD";
  return (
    <>
      <section
        className="order-status__card order-status__summary"
        aria-labelledby="order-progress-heading"
      >
        <p className="bop-eyebrow">Order {view.order.orderNumber}</p>
        <h2 id="order-progress-heading">{progressHeading}</h2>
        <p>{progressMessage}</p>
        {storeCancelled ? (
          <p className="order-status__refund">{staffRefundText(storeCancelled)}</p>
        ) : null}
        <dl>
          <div>
            <dt>Order type</dt>
            <dd>{view.order.orderType === "DineIn" ? "Dine in" : "Pickup"}</dd>
          </div>
          {kitchenText === null ? null : (
            <div>
              <dt>Kitchen status</dt>
              <dd>{kitchenText}</dd>
            </div>
          )}
          {paymentLabel === null ? null : (
            <div>
              <dt>Payment</dt>
              <dd>{paymentLabel}</dd>
            </div>
          )}
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
          <h2>Payment update may be delayed</h2>
          <p>This payment update may be out of date. Refresh to check again.</p>
        </section>
      ) : null}

      {view.freshnessStatus !== "Fresh" ? (
        <section className="order-status__warning" role="status">
          <h2>Status may be delayed</h2>
          <p>
            {view.freshnessStatus === "Rebuilding"
              ? "We are updating your order status. Check again shortly."
              : view.freshnessStatus === "Failed"
                ? "We could not update your order status. The details below may be out of date."
                : "The details below may be out of date. Refresh to check for an update."}
          </p>
        </section>
      ) : null}

      <section className="order-status__batches" aria-labelledby="order-items-heading">
        <h2 id="order-items-heading">Your items</h2>
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
              {multipleBatches ? <h3>Round {index + 1}</h3> : null}
              {unpaidCancelled.has(batch.orderBatchReference) ? (
                <p className="order-status__batch-cancelled">
                  {multipleBatches
                    ? "This round was cancelled because its payment didn't go through. You were not charged for it."
                    : "This order was cancelled because its payment didn't go through. You were not charged for it."}
                </p>
              ) : failedPayment(batch.orderBatchReference) !== null ? (
                <p className="order-status__warning" role="status">
                  {multipleBatches
                    ? "Payment for this round didn't go through. "
                    : "Payment for your order didn't go through. "}
                  It will be cancelled at{" "}
                  {endSentence(formatClockTime(failedPayment(batch.orderBatchReference) ?? ""))} Ask
                  a staff member if you need help.
                </p>
              ) : batchCancellation ? (
                <p className="order-status__batch-cancelled">
                  {multipleBatches
                    ? "This round was cancelled by the store. "
                    : "Cancelled by the store. "}
                  {staffCancellationReasonText[batchCancellation.reason]}{" "}
                  {staffRefundText(batchCancellation)}
                </p>
              ) : kitchen && multipleBatches ? (
                <p>
                  {batchKitchen?.status === "Ready"
                    ? "Ready"
                    : batchKitchen?.status === "InProgress"
                      ? "Preparing"
                      : batchKitchen
                        ? "In the queue"
                        : "Not started yet"}
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
                      </span>
                      <span className="order-status__item-amount">
                        {formatMoney(item.lineTotal.amountMinor, item.lineTotal.currencyCode)}
                      </span>
                      {itemCancellation ? (
                        <span className="order-status__item-cancelled">
                          {itemCancellationText(itemCancellation)}
                        </span>
                      ) : batchCancelled ? (
                        <span className="order-status__item-cancelled">Cancelled</span>
                      ) : notPaid.has(batch.orderBatchReference) ? (
                        <span className="order-status__item-cancelled">Not paid</span>
                      ) : remaking(item.orderItemReference) && !complete ? (
                        <span className="order-status__item-remake">Being remade</span>
                      ) : view.sources?.dining ? (
                        <span>
                          Served{" "}
                          {
                            view.sources.dining.items.find(
                              (entry) =>
                                entry.orderItemReference === item.orderItemReference &&
                                entry.orderBatchReference === batch.orderBatchReference,
                            )?.servedQuantity
                          }{" "}
                          of {item.quantity}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </article>
          );
        })}
        <p className="order-status__total">
          <span>Items total</span>
          <span>{formatMoney(total, currency)}</span>
        </p>
        {notPaid.size > 0 ? (
          <p className="order-status__item-refund">
            Rounds that weren&apos;t paid are not included.
          </p>
        ) : null}
        {/* A whole store cancellation states its own full refund; the item note would contradict it. */}
        {(storeCancelled ? [] : itemRefundSummary(itemCancellations)).map((line) => (
          <p key={line} className="order-status__item-refund">
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
export function VisitEndedNotice() {
  return (
    <section className="order-status__card order-status__visit-ended" role="alert">
      <h2>Your visit on this phone has ended</h2>
      <p>
        At a table: your table visit ended or expired. Scan the table QR code again and ask a staff
        member for the table code to continue. While your table is still open, your earlier orders
        are on your table page.
      </p>
      <p>
        For a pickup order: the store still has your order. Give your name or order number at the
        counter.
      </p>
      <Link className="order-status__retry" to="/">
        Go to the start
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
  const polling =
    state.status === "ready" && state.realtime !== "available" && !isOrderSettled(state.view);
  useEffect(() => {
    if (!polling) return;
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState === "visible")
        void controller.refresh();
    };
    const timer = window.setInterval(tick, orderStatusPollIntervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [controller, polling]);
  return (
    <CustomerPage
      step="order"
      store={store}
      orderReference={orderReference}
      className="order-status"
    >
      <header className="customer-heading">
        <p className="bop-eyebrow">Order status</p>
        <h2>Track your order</h2>
      </header>

      {state.status === "loading" ? (
        <section role="status">
          <h2>Loading order status</h2>
        </section>
      ) : null}
      {state.status === "invalid-reference" ? (
        <section role="alert">
          <h2>Order link is invalid</h2>
          <p>Use the exact link provided after checkout.</p>
        </section>
      ) : null}
      {state.status === "permission-denied" ? <VisitEndedNotice /> : null}
      {state.status === "not-found" ? (
        <section className="order-status__unavailable" role="alert">
          <h2>We can&apos;t show this order here yet</h2>
          <p>
            If you just paid, your order can take a few seconds to appear. Try again in a moment.
          </p>
          <button
            className="order-status__retry"
            type="button"
            onClick={() => void controller.refresh()}
          >
            Try again
          </button>
          <p>
            This page only opens orders placed on this phone or browser. If it still doesn&apos;t
            open, ask a staff member with your order number.
          </p>
        </section>
      ) : null}
      {state.status === "feature-disabled" ? (
        <section role="alert">
          <h2>Order tracking is disabled</h2>
        </section>
      ) : null}
      {state.status === "unavailable" ? (
        <section className="order-status__unavailable" role="alert">
          <span className="order-status__unavailable-icon" aria-hidden="true">
            !
          </span>
          <h2>Order status is not available</h2>
          <p>We could not load your order status. Please try again.</p>
          <button
            className="order-status__retry"
            type="button"
            onClick={() => void controller.refresh()}
          >
            Try loading status
          </button>
        </section>
      ) : null}
      {state.status === "offline" ? (
        <section role="status" className="order-status__warning">
          <h2>You’re offline</h2>
          <p>
            {view
              ? "Showing the last status loaded on this page."
              : "Connect to the internet to load your order status."}{" "}
            Reconnect and refresh to check again.
          </p>
          <button
            className="order-status__retry"
            type="button"
            onClick={() => void controller.refresh()}
          >
            Try loading status
          </button>
        </section>
      ) : null}
      {view ? <StatusContent view={view} pickupController={pickupController} /> : null}
      {state.status === "ready" ? (
        <section className="order-status__actions" aria-label="Updates">
          <p>
            {state.realtime === "available"
              ? "Live updates are on."
              : isOrderSettled(state.view)
                ? "This order is complete."
                : "This page checks for updates every few seconds."}
          </p>
          <button
            type="button"
            disabled={state.refreshing}
            onClick={() => void controller.refresh()}
          >
            {state.refreshing ? "Refreshing…" : "Refresh now"}
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
          See everything your table ordered
        </Link>
      ) : null}
      {view ? (
        <Link className="order-status__receipt" to={`/orders/${view.order.orderReference}/receipt`}>
          View receipt and support
        </Link>
      ) : null}
      <Link className="order-status__back" to="/menu">
        Back to menu
      </Link>
    </CustomerPage>
  );
}
