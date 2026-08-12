import { useEffect, useState, useSyncExternalStore } from "react";
import { Link, useParams } from "react-router";
import {
  createOrderStatusController,
  createUnavailableOrderStatusClient,
  type OrderStatusController,
} from "./order-status-controller.js";
import type { OrderStatusView } from "./types.js";

function money(amountMinor: bigint, currencyCode: string): string {
  const negative = amountMinor < 0n;
  const absolute = negative ? -amountMinor : amountMinor;
  return `${negative ? "−" : ""}${currencyCode} ${absolute / 100n}.${(absolute % 100n)
    .toString()
    .padStart(2, "0")}`;
}

function StatusContent({ view }: { readonly view: OrderStatusView }) {
  const complete = view.order.fulfillmentStatus === "Completed";
  return (
    <>
      <section className="order-status__summary" aria-labelledby="order-progress-heading">
        <p className="cart-page__eyebrow">Order {view.order.orderNumber}</p>
        <h2 id="order-progress-heading">{complete ? "Order completed" : "Order submitted"}</h2>
        <dl>
          <div>
            <dt>Order type</dt>
            <dd>{view.order.orderType === "DineIn" ? "Dine in" : "Pickup"}</dd>
          </div>
          <div>
            <dt>Kitchen status</dt>
            <dd>Not available yet</dd>
          </div>
          <div>
            <dt>Estimated time</dt>
            <dd>Not available yet</dd>
          </div>
          <div>
            <dt>Payment status</dt>
            <dd>Not reported on this screen</dd>
          </div>
        </dl>
        <p>
          {complete
            ? "The Ordering record confirms fulfillment is complete."
            : "We have your order."}
        </p>
      </section>

      {view.freshnessStatus !== "Fresh" ? (
        <section className="order-status__warning" role="status">
          <h2>Status may be delayed</h2>
          <p>Projection state: {view.freshnessStatus}. Refresh before relying on a change.</p>
        </section>
      ) : null}

      <section aria-labelledby="order-items-heading">
        <h2 id="order-items-heading">Order batches</h2>
        {view.order.batches.map((batch, index) => (
          <article key={batch.orderBatchReference} className="order-status__batch">
            <h3>Batch {index + 1}</h3>
            <ul>
              {batch.items.map((item) => (
                <li key={item.orderItemReference}>
                  <span>
                    {item.quantity} × {item.displayName}
                  </span>
                  <span>{money(item.lineTotal.amountMinor, item.lineTotal.currencyCode)}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </section>
    </>
  );
}

export function OrderStatusPage({
  controller: provided,
}: {
  readonly controller?: OrderStatusController;
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
        <p>The Order reference identifies this page. Your Guest Session authorizes access.</p>
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
          <p>This Guest Session is not authorized for that Order.</p>
        </section>
      ) : null}
      {state.status === "not-found" ? (
        <section role="alert">
          <h2>Order not found</h2>
          <p>No authorized Order was found for this link.</p>
        </section>
      ) : null}
      {state.status === "feature-disabled" ? (
        <section role="alert">
          <h2>Order tracking is disabled</h2>
        </section>
      ) : null}
      {state.status === "unavailable" ? (
        <section role="alert">
          <h2>Order status is not available</h2>
          <p>The public Guest Order adapter is not available. No request was retried.</p>
        </section>
      ) : null}
      {state.status === "offline" ? (
        <section role="status" className="order-status__warning">
          <h2>Offline read-only</h2>
          <p>
            {view
              ? "Showing the last accepted status from this page."
              : "No accepted status is available on this page."}{" "}
            Reconnecting does not refresh automatically.
          </p>
        </section>
      ) : null}
      {view ? <StatusContent view={view} /> : null}
      {state.status === "ready" ? (
        <section className="order-status__actions">
          <h2>Updates</h2>
          <p>
            {state.realtime === "available"
              ? "Realtime hints are connected."
              : state.realtime === "connecting"
                ? "Connecting for update hints."
                : "Realtime hints are unavailable; use manual refresh."}
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
      <section className="order-status__boundary">
        <h2>Later actions</h2>
        <p>Pickup proof, receipt and support actions are not available in this package.</p>
      </section>
      <Link to="/menu">Back to menu</Link>
    </main>
  );
}
