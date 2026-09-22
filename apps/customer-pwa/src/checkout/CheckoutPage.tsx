import { createCheckoutSessionClient } from "./session-client.js";
import { createCheckoutSessionController } from "./session-controller.js";
import { v7 as uuidv7 } from "uuid";
import { parseTipAmount } from "./tip-amount.js";
import {
  setCheckoutSessionReference,
  setCheckoutTipSelection,
} from "../session/customer-transaction-context.js";
import { captureCustomerCsrfContext } from "../session/customer-transaction-context.js";
import { CheckoutDetailsForm, type CheckoutFormSelection } from "./CheckoutDetailsForm.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
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
  const [detailsLocked, setDetailsLocked] = useState(false);
  const [confirmedQuote, setConfirmedQuote] = useState<string | null>(null);
  const navigate = useNavigate();
  const [sessionController] = useState(() =>
    createCheckoutSessionController(createCheckoutSessionClient()),
  );
  const sessionState = useSyncExternalStore(
    sessionController.subscribe,
    sessionController.getState,
    sessionController.getState,
  );
  const [tip, setTip] = useState("");
  const tipAmount = parseTipAmount(tip);
  const selectedTip = useRef<{ selectionReference: string; amountMinor: string } | null>(null);
  const [readyDetails, setReadyDetails] = useState<CheckoutFormSelection | null>(null);
  useEffect(() => {
    if (sessionState.status === "ready" && selectedTip.current) {
      setCheckoutSessionReference(sessionState.session.checkoutSessionReference);
      setCheckoutTipSelection({
        checkoutSessionReference: sessionState.session.checkoutSessionReference,
        ...selectedTip.current,
      });
      void navigate("/checkout/payment");
    }
  }, [navigate, sessionState]);
  useEffect(() => {
    const offline = () => sessionController.setOnline(false);
    const online = () => sessionController.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [sessionController]);

  const [retained, setRetained] = useState<{
    selection: CheckoutFormSelection;
    current: () => boolean;
  } | null>(null);
  const quoteAction = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (state.status === "quote-expired" && document.activeElement === document.body)
      quoteAction.current?.focus();
  }, [state.status]);
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
  if (
    cart &&
    quote &&
    (quote.quoteVersion === 1 || quote.quoteVersion === 2) &&
    (cart.cart.orderType === "DineIn" || cart.cart.orderType === "Pickup") &&
    retained?.selection.quoteReference !== quote.quoteReference
  ) {
    setRetained({
      selection: {
        cartReference: cart.cart.cartReference,
        cartVersion: cart.cart.version,
        quoteReference: quote.quoteReference,
        quoteVersion: quote.quoteVersion,
        orderType: cart.cart.orderType,
        quoteExpiresAt: quote.expiresAt,
      },
      current: captureCustomerCsrfContext(),
    });
  }
  const detailsSelection =
    retained?.current() &&
    cart &&
    retained.selection.cartReference === cart.cart.cartReference &&
    retained.selection.cartVersion === cart.cart.version &&
    (state.status === "ready" || state.status === "offline")
      ? retained.selection
      : null;
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
      {cart &&
      quote === null &&
      ["ready", "conflict", "validation", "unavailable", "quote-expired"].includes(state.status) ? (
        <button
          ref={quoteAction}
          disabled={detailsLocked || sessionState.status !== "idle"}
          type="button"
          onClick={() => void controller.quote()}
        >
          {state.status === "quote-expired" ? "Get a new quote" : "Get current quote"}
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
              <button
                type="button"
                disabled={detailsLocked || sessionState.status !== "idle"}
                onClick={() => void controller.quote()}
              >
                Get a new quote
              </button>
            </div>
          ) : null}
          {quote.priceChange?.requiresReconfirmation ? (
            <div role="alert">
              <p>Price changed. Confirm the new total before continuing.</p>
              <label>
                <input
                  type="checkbox"
                  checked={confirmedQuote === quote.quoteReference}
                  disabled={sessionState.status !== "idle"}
                  onChange={(event) =>
                    setConfirmedQuote(event.target.checked ? quote.quoteReference : null)
                  }
                />{" "}
                I confirm the changed price
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
        "quote-expired",
      ].includes(state.status) ? (
        <section role="alert">
          <h2>Checkout needs attention</h2>
          <p>
            {state.status === "quote-expired"
              ? "Your previous quote expired. You can request a new quote."
              : state.status === "offline"
                ? "Offline read-only. Nothing will replay."
                : state.status === "outcome-unknown"
                  ? "The Quote outcome is unknown; no success was assumed."
                  : `Checkout state: ${state.status}`}
          </p>
          {"canRetry" in state && state.canRetry ? (
            <button
              type="button"
              disabled={state.status === "offline"}
              onClick={() => void controller.retry()}
            >
              Retry the same Quote request
            </button>
          ) : null}
        </section>
      ) : null}
      {detailsSelection ? (
        <CheckoutDetailsForm
          key={
            detailsSelection.cartReference +
            ":" +
            detailsSelection.cartVersion +
            ":" +
            detailsSelection.quoteReference
          }
          now={now}
          selection={detailsSelection}
          onBusyChange={setDetailsLocked}
          onReadyChange={setReadyDetails}
        />
      ) : null}
      <section className="checkout-boundary">
        <h2>Fulfillment and payment</h2>
        <p>Save your checkout details before continuing to secure payment.</p>
        <label htmlFor="checkout-tip">Tip (CAD)</label>
        <input
          id="checkout-tip"
          inputMode="decimal"
          autoComplete="off"
          value={tip}
          disabled={sessionState.status !== "idle" || state.status !== "ready"}
          onChange={(event) => setTip(event.target.value)}
          aria-invalid={tip !== "" && tipAmount === null}
          aria-describedby="checkout-tip-help"
        />
        <p id="checkout-tip-help">
          {tip !== "" && tipAmount === null
            ? "Enter a valid amount with up to two decimal places."
            : "Enter 0 for no tip. Your selection is fixed when you continue to payment."}
        </p>
        {sessionState.status === "pending" ? <p role="status">Preparing secure payment…</p> : null}
        {"canRetry" in sessionState ? (
          <p role="alert">
            {sessionState.canRetry
              ? "We could not confirm checkout. Retry to recover the same checkout."
              : "Checkout is unavailable. Review your cart and sign in again if needed."}
          </p>
        ) : null}
        {"canRetry" in sessionState && sessionState.canRetry ? (
          <button
            type="button"
            onClick={() => void sessionController.retry()}
            disabled={state.status === "offline"}
          >
            Retry checkout
          </button>
        ) : (
          <button
            type="button"
            disabled={
              sessionState.status !== "idle" ||
              state.status !== "ready" ||
              tipAmount === null ||
              quoteExpired ||
              quote === null ||
              quote.blockingReasons.length > 0 ||
              (quote.priceChange?.requiresReconfirmation === true &&
                confirmedQuote !== quote.quoteReference) ||
              detailsLocked ||
              readyDetails === null ||
              detailsSelection === null ||
              readyDetails.cartReference !== detailsSelection.cartReference ||
              readyDetails.cartVersion !== detailsSelection.cartVersion ||
              readyDetails.quoteReference !== detailsSelection.quoteReference
            }
            onClick={() => {
              if (detailsSelection && readyDetails && !quoteExpired && tipAmount !== null) {
                selectedTip.current ??= { selectionReference: uuidv7(), amountMinor: tipAmount };
                void sessionController.start(detailsSelection);
              }
            }}
          >
            Continue to payment
          </button>
        )}
      </section>
      <Link to="/cart">Back to cart</Link>
    </main>
  );
}
