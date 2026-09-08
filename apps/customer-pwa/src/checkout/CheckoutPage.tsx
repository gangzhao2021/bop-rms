import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { createBrowserCustomerCartClient } from "../cart/cart-client.js";
import { formatCartMoney } from "../cart/format-money.js";
import {
  createCheckoutClient,
  createCheckoutController,
  type CheckoutController,
} from "./checkout-client.js";

export function CheckoutPage({
  controller: provided,
  now = Date.now,
}: {
  readonly controller?: CheckoutController;
  readonly now?: () => number;
}) {
  const [controller] = useState(
    () =>
      provided ?? createCheckoutController(createCheckoutClient(createBrowserCustomerCartClient())),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  const [, setClockRevision] = useState(0);
  useEffect(() => {
    void controller.load();
    const offline = () => controller.setOnline(false);
    const online = () => controller.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [controller]);
  const cart = "cart" in state ? state.cart : null;
  const quote = state.status === "ready" ? state.quote : null;
  const quoteExpired = quote !== null && Date.parse(quote.expiresAt) <= now();
  useEffect(() => {
    if (quote === null || quoteExpired) return;
    const remaining = Date.parse(quote.expiresAt) - now();
    const timer = window.setTimeout(
      () => setClockRevision((revision) => revision + 1),
      Math.min(remaining + 1, 2_147_483_647),
    );
    return () => window.clearTimeout(timer);
  }, [now, quote, quoteExpired]);
  return (
    <main id="main-content" className="checkout-page">
      <header>
        <p className="cart-page__eyebrow">Checkout review</p>
        <h1>Review your order</h1>
        <p>Server Quote and current Cart only</p>
      </header>
      {state.status === "loading" ? (
        <section role="status">
          <h2>Loading checkout</h2>
          <p>Checking the current Cart…</p>
        </section>
      ) : null}
      {state.status === "empty" ? (
        <section>
          <h2>No checkout is available</h2>
          <p>Add an item before checkout.</p>
          <Link to="/menu">Browse menu</Link>
        </section>
      ) : null}
      {cart ? (
        <section aria-labelledby="checkout-items">
          <h2 id="checkout-items">Items</h2>
          {cart.cart.items.map((item) => (
            <article key={item.cartItemReference}>
              <h3>{item.displayName}</h3>
              <p>Quantity {item.quantity}</p>
            </article>
          ))}
        </section>
      ) : null}
      {cart && quote === null && state.status !== "pending" ? (
        <button type="button" onClick={() => void controller.quote()}>
          Get current quote
        </button>
      ) : null}
      {state.status === "pending" ? <p role="status">Requesting the server Quote…</p> : null}
      {quote ? (
        <section aria-labelledby="quote-heading">
          <h2 id="quote-heading">Quote summary</h2>
          <dl>
            {(
              [
                ["Subtotal", quote.subtotal],
                ["Discount", quote.discount],
                ["Tax", quote.tax],
                ["Fee", quote.fee],
                ["Total", quote.total],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{formatCartMoney(value)}</dd>
              </div>
            ))}
          </dl>
          <p>
            Expires <time dateTime={quote.expiresAt}>{quote.expiresAt}</time>.
          </p>
          {quoteExpired ? (
            <div role="alert">
              <p>Quote expired. Request a current server Quote before continuing.</p>
              <button type="button" onClick={() => void controller.quote()}>
                Get a new quote
              </button>
            </div>
          ) : null}
          {quote.priceChange?.requiresReconfirmation ? (
            <div role="alert">
              <p>Price changed. Confirm the new total before continuing.</p>
              <label>
                <input type="checkbox" /> I confirm the changed price
              </label>
            </div>
          ) : null}
          {[...quote.warnings, ...quote.blockingReasons].map((item) => (
            <p className="cart-warning" key={item}>
              {item}
            </p>
          ))}
        </section>
      ) : null}
      {[
        "offline",
        "session-expired",
        "conflict",
        "validation",
        "unavailable",
        "outcome-unknown",
      ].includes(state.status) ? (
        <section role="alert">
          <h2>Checkout needs attention</h2>
          <p>
            {state.status === "offline"
              ? "Offline read-only. Nothing will replay."
              : state.status === "outcome-unknown"
                ? "The Quote outcome is unknown; no success was assumed."
                : `Checkout state: ${state.status}`}
          </p>
          {"canRetry" in state && state.canRetry ? (
            <button type="button" onClick={() => void controller.retry()}>
              Retry the same Quote request
            </button>
          ) : null}
        </section>
      ) : null}
      <section className="checkout-boundary">
        <h2>Fulfillment and payment</h2>
        <p>Contact, capacity hold, tip and receipt-choice adapters are unavailable.</p>
        <button type="button" disabled>
          Continue to payment
        </button>
        <p>Payment remains gated until an approved Provider and public Guest adapter exist.</p>
      </section>
      <Link to="/cart">Back to cart</Link>
    </main>
  );
}
