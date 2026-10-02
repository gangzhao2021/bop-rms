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

function money(amountMinor: bigint, currencyCode: string): string {
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  return `${negative ? "−" : ""}${currencyCode} ${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
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
  const kitchen = view.sources?.kitchen;
  const kitchenLabel = !kitchen
    ? "Not available yet"
    : kitchen.batches.length === view.order.batches.length &&
        kitchen.batches.every((batch) => batch.status === "Ready")
      ? "Ready"
      : kitchen.batches.some((batch) => batch.status !== "Queued")
        ? "Preparing"
        : "Queued";
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
          ? ["Order collected", "Your order has been collected."]
          : allServed
            ? ["Items served", "All listed items have been served."]
            : someServed
              ? [
                  "Serving your order",
                  "Some items have been served. Check the remaining items below.",
                ]
              : kitchenLabel === "Ready"
                ? ["Kitchen preparation complete", "All listed batches are ready."]
                : kitchenLabel === "Preparing"
                  ? ["Preparing your order", "The kitchen is preparing your order."]
                  : ["Order submitted", "We have your order."];
  const payments = view.sources?.payments;
  return (
    <>
      <section
        className="order-status__card order-status__summary"
        aria-labelledby="order-progress-heading"
      >
        <p className="cart-page__eyebrow">Order {view.order.orderNumber}</p>
        <h2 id="order-progress-heading">{progressHeading}</h2>
        <dl>
          <div>
            <dt>Order type</dt>
            <dd>{view.order.orderType === "DineIn" ? "Dine in" : "Pickup"}</dd>
          </div>
          <div>
            <dt>Kitchen status</dt>
            <dd>{kitchenLabel}</dd>
          </div>
          <div>
            <dt>Estimated time</dt>
            <dd>Not available yet</dd>
          </div>
          <div>
            <dt>Payment status</dt>
            <dd>
              {payments == null
                ? "Payment updates are unavailable"
                : payments.length === 0
                  ? "No payment result has been reported yet"
                  : "See individual payment updates below"}
            </dd>
          </div>
        </dl>
        <p>{progressMessage}</p>
      </section>

      {payments && payments.length > 0 ? (
        <section
          className="order-status__card order-status__payments"
          aria-labelledby="order-payment-updates-heading"
        >
          <h2 id="order-payment-updates-heading">Payment updates</h2>
          <ul>
            {payments.map((payment, index) => (
              <li key={index}>
                <p>
                  {payment.status === "Succeeded" && payment.amount
                    ? `Payment received: ${money(payment.amount.amountMinor, payment.amount.currencyCode)}`
                    : "Payment attempt failed"}
                </p>
                {payment.freshnessStatus !== "Fresh" ? (
                  <p role="status">
                    This payment update may be out of date. Refresh to check again.
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          <p>
            These are individual payment results. They do not confirm that the order is fully paid
            or show any later refunds.
          </p>
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
        <h2 id="order-items-heading">Order batches</h2>
        {view.order.batches.map((batch, index) => (
          <article
            key={batch.orderBatchReference}
            className="order-status__card order-status__batch"
          >
            <h3>Batch {index + 1}</h3>
            {kitchen ? (
              <p>
                {kitchen.batches.find(
                  (entry) => entry.orderBatchReference === batch.orderBatchReference,
                )?.status === "Ready"
                  ? "Ready"
                  : kitchen.batches.find(
                        (entry) => entry.orderBatchReference === batch.orderBatchReference,
                      )?.status === "InProgress"
                    ? "Preparing"
                    : kitchen.batches.some(
                          (entry) => entry.orderBatchReference === batch.orderBatchReference,
                        )
                      ? "Queued"
                      : "Not available yet"}
              </p>
            ) : null}
            <ul>
              {batch.items.map((item) => (
                <li key={item.orderItemReference}>
                  <span>
                    {item.quantity} × {item.displayName}
                  </span>
                  <span>{money(item.lineTotal.amountMinor, item.lineTotal.currencyCode)}</span>
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
        ))}
      </section>
      {view.order.orderType === "Pickup" && !complete ? (
        <PickupCodePanel
          orderReference={view.order.orderReference}
          orderNumber={view.order.orderNumber}
          controller={pickupController}
        />
      ) : null}
    </>
  );
}

export function OrderStatusPage({
  controller: provided,
  pickupController,
}: {
  readonly controller?: OrderStatusController;
  readonly pickupController?: PickupCodeController | undefined;
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
  return (
    <main id="main-content" className="order-status">
      <header>
        <p className="cart-page__eyebrow">Order status</p>
        <h1>Track your order</h1>
        <p>Check your order progress and available next steps.</p>
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
          <h2>Offline read-only</h2>
          <p>
            {view
              ? "Showing the last status loaded on this page."
              : "Connect to the internet to load your order status."}{" "}
            Reconnecting does not refresh automatically.
          </p>
        </section>
      ) : null}
      {state.status === "offline" ? (
        <button
          className="order-status__retry"
          type="button"
          onClick={() => void controller.refresh()}
        >
          Try loading status
        </button>
      ) : null}
      {view ? <StatusContent view={view} pickupController={pickupController} /> : null}
      {state.status === "ready" ? (
        <section className="order-status__actions">
          <h2>Updates</h2>
          <p>
            {state.realtime === "available"
              ? "Order updates are connected."
              : state.realtime === "connecting"
                ? "Connecting for order updates."
                : "Automatic updates are unavailable. Refresh to check your order."}
          </p>
          <button
            type="button"
            disabled={state.refreshing}
            onClick={() => void controller.refresh()}
          >
            {state.refreshing ? "Refreshing…" : "Refresh status"}
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
    </main>
  );
}
