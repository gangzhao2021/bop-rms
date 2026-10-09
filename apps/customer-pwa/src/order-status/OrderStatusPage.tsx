import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import {
  createOrderStatusController,
  createUnavailableOrderStatusClient,
  type OrderStatusController,
} from "./order-status-controller.js";
import type { OrderStatusView } from "./types.js";
import { PickupCodePanel } from "../pickup-code/PickupCodePanel.js";
import type { PickupCodeController } from "../pickup-code/pickup-code-controller.js";
import { CustomerPage, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { formatMoney } from "../journey/format.js";

/** How often an active order re-reads its status when no live connection is available. */
export const orderStatusPollIntervalMs = 15_000;

export function isOrderSettled(view: OrderStatusView): boolean {
  const phase = view.order.canonicalPhase;
  return (
    phase === "Fulfilled" ||
    phase === "Cancelled" ||
    phase === "Rejected" ||
    view.order.fulfillmentStatus === "Completed" ||
    Boolean(view.sources?.pickup?.notCollectedAt)
  );
}

function kitchenStatus(view: OrderStatusView): "Ready" | "Preparing" | "Queued" | "Unknown" {
  const kitchen = view.sources?.kitchen;
  if (!kitchen) return "Unknown";
  if (
    kitchen.batches.length === view.order.batches.length &&
    kitchen.batches.every((batch) => batch.status === "Ready")
  )
    return "Ready";
  return kitchen.batches.some((batch) => batch.status !== "Queued") ? "Preparing" : "Queued";
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
  const kitchen = view.sources?.kitchen;
  const kitchenLabel = kitchenStatus(view);
  const diningItems = view.order.orderType === "DineIn" ? view.sources?.dining?.items : undefined;
  const allServed =
    diningItems !== undefined &&
    view.order.batches.every((batch) =>
      batch.items.every((item) =>
        diningItems.some(
          (served) =>
            served.orderBatchReference === batch.orderBatchReference &&
            served.orderItemReference === item.orderItemReference &&
            served.servedQuantity === item.quantity,
        ),
      ),
    );
  const someServed = diningItems?.some((item) => item.servedQuantity > 0) === true;
  const [progressHeading, progressMessage] =
    view.order.canonicalPhase === "Cancelled"
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
      ? "Payment updates unavailable"
      : paid?.amount
        ? `Payment received ${formatMoney(paid.amount.amountMinor, paid.amount.currencyCode)}`
        : payments.some((payment) => payment.status === "Failed")
          ? "Payment attempt failed"
          : "Payment pending";
  const multipleBatches = view.order.batches.length > 1;
  const total = view.order.batches
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
        <dl>
          <div>
            <dt>Order type</dt>
            <dd>{view.order.orderType === "DineIn" ? "Dine in" : "Pickup"}</dd>
          </div>
          <div>
            <dt>Kitchen status</dt>
            <dd>
              {kitchenLabel === "Unknown"
                ? "Not available yet"
                : kitchenLabel === "Queued"
                  ? "In the queue"
                  : kitchenLabel}
            </dd>
          </div>
          <div>
            <dt>Payment</dt>
            <dd>{paymentLabel}</dd>
          </div>
        </dl>
      </section>

      {view.order.orderType === "Pickup" && !complete && !notCollected ? (
        <PickupCodePanel
          orderReference={view.order.orderReference}
          orderNumber={view.order.orderNumber}
          controller={pickupController}
          autoReveal={kitchenLabel === "Ready" || view.order.canonicalPhase === "Ready"}
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
          return (
            <article
              key={batch.orderBatchReference}
              className="order-status__card order-status__batch"
            >
              {multipleBatches ? <h3>Round {index + 1}</h3> : null}
              {kitchen && multipleBatches ? (
                <p>
                  {batchKitchen?.status === "Ready"
                    ? "Ready"
                    : batchKitchen?.status === "InProgress"
                      ? "Preparing"
                      : batchKitchen
                        ? "In the queue"
                        : "Not available yet"}
                </p>
              ) : null}
              <ul>
                {batch.items.map((item) => (
                  <li key={item.orderItemReference}>
                    <span>
                      {item.quantity} × {item.displayName}
                    </span>
                    <span>
                      {formatMoney(item.lineTotal.amountMinor, item.lineTotal.currencyCode)}
                    </span>
                    {view.sources?.dining ? (
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
                ))}
              </ul>
            </article>
          );
        })}
        <p className="order-status__total">
          <span>Items total</span>
          <span>{formatMoney(total, currency)}</span>
        </p>
      </section>
    </>
  );
}

export function OrderStatusPage({
  controller: provided,
  pickupController,
  store,
}: {
  readonly controller?: OrderStatusController;
  readonly pickupController?: PickupCodeController | undefined;
  readonly store?: CustomerStoreContext | undefined;
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
      {state.status === "permission-denied" ? (
        <section role="alert">
          <h2>Order access denied</h2>
          <p>Open this order in the browser you used at checkout.</p>
        </section>
      ) : null}
      {state.status === "not-found" ? (
        <section role="alert">
          <h2>This order cannot be opened</h2>
          <p>
            Check your order link and use the browser you used at checkout. Your access session may
            have ended. Ask the store for help if you still cannot open it.
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
