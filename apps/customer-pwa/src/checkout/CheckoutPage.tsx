import { createCheckoutSessionClient } from "./session-client.js";
import { createCheckoutSessionController } from "./session-controller.js";
import { v7 as uuidv7 } from "uuid";
import { parseTipAmount } from "./tip-amount.js";
import {
  setCheckoutSessionReference,
  setCheckoutTipSelection,
} from "../session/customer-transaction-context.js";
import { captureCustomerCsrfContext } from "../session/customer-transaction-context.js";
import {
  CheckoutDetailsForm,
  type CheckoutDetailsFormHandle,
  type CheckoutFormSelection,
} from "./CheckoutDetailsForm.js";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, useNavigate } from "react-router";
import { createBrowserCustomerCartClient } from "../cart/cart-client.js";
import { formatCartMoney } from "../cart/format-money.js";
import { describeConfiguration } from "../cart/CartPage.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import { formatMinutesUntil, formatMoney, percentOfMinor } from "../journey/format.js";
import { lineEstimateLabel, quoteIssueMessage } from "../journey/messages.js";
import {
  createCheckoutClient,
  createCheckoutController,
  type CheckoutController,
} from "./checkout-client.js";

const tipPresets = [0, 10, 15, 18] as const;
type TipChoice = (typeof tipPresets)[number] | "custom";

/** Dollars-and-cents text for a minor-unit amount, for the custom tip field. */
function minorToText(minor: string): string {
  const digits = minor.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export function CheckoutPage({
  controller: provided,
  now = Date.now,
  store,
}: {
  readonly controller?: CheckoutController;
  readonly now?: () => number;
  readonly store?: CustomerStoreContext | undefined;
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
  const [tipChoice, setTipChoice] = useState<TipChoice>(0);
  const [customTip, setCustomTip] = useState("");
  const selectedTip = useRef<{ selectionReference: string; amountMinor: string } | null>(null);
  const [readyDetails, setReadyDetails] = useState<CheckoutFormSelection | null>(null);
  const [detailsSubmittable, setDetailsSubmittable] = useState(false);
  const detailsForm = useRef<CheckoutDetailsFormHandle>(null);
  const [continueRequested, setContinueRequested] = useState(false);
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
  // U1: the Store prices the order as soon as the cart is known (and again after a reconnect);
  // no "get a quote" tap. A failed attempt leaves a non-ready state, so this cannot loop.
  useEffect(() => {
    if (state.status !== "ready" || state.quote !== null) return;
    void controller.quote();
  }, [controller, state]);
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
  // The form stays mounted while the same cart is re-priced (pending) so an in-flight details
  // save and its retry survive a reconnect; a new quote reference remounts it on purpose.
  const detailsSelection =
    retained?.current() &&
    cart &&
    retained.selection.cartReference === cart.cart.cartReference &&
    retained.selection.cartVersion === cart.cart.version &&
    (state.status === "ready" || state.status === "offline" || state.status === "pending")
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
  const tipAmount =
    tipChoice === "custom"
      ? parseTipAmount(customTip)
      : quote === null
        ? "0"
        : percentOfMinor(quote.subtotal.amountMinor, tipChoice);
  const detailsReady =
    readyDetails !== null &&
    detailsSelection !== null &&
    readyDetails.cartReference === detailsSelection.cartReference &&
    readyDetails.cartVersion === detailsSelection.cartVersion &&
    readyDetails.quoteReference === detailsSelection.quoteReference;
  const canContinue =
    sessionState.status === "idle" &&
    state.status === "ready" &&
    tipAmount !== null &&
    !quoteExpired &&
    quote !== null &&
    quote.blockingReasons.length === 0 &&
    !(
      quote.priceChange?.requiresReconfirmation === true && confirmedQuote !== quote.quoteReference
    ) &&
    !detailsLocked &&
    detailsSelection !== null &&
    (detailsReady || detailsSubmittable);
  const startPayment = () => {
    if (!detailsSelection || quoteExpired || tipAmount === null) return;
    selectedTip.current ??= { selectionReference: uuidv7(), amountMinor: tipAmount };
    void sessionController.start(detailsSelection);
  };
  useEffect(() => {
    if (!continueRequested) return;
    if (detailsReady && canContinue) {
      setContinueRequested(false);
      startPayment();
    } else if (!detailsLocked && !detailsReady) {
      // The save ended without a usable acknowledgement; the form shows why.
      setContinueRequested(false);
    }
    // startPayment reads refs and the latest selection; the effect keys cover every input.
  }, [canContinue, continueRequested, detailsLocked, detailsReady]);
  const requestContinue = async () => {
    if (!canContinue) return;
    if (detailsReady) {
      startPayment();
      return;
    }
    setContinueRequested(true);
    await detailsForm.current?.save();
  };
  const resolvedStore: CustomerStoreContext | undefined =
    store ??
    (cart
      ? {
          storeName: cart.cart.context.storeName,
          brandName: cart.cart.context.brandName,
          serviceMode: cart.cart.orderType,
        }
      : undefined);
  const remaining = quote === null ? null : formatMinutesUntil(quote.expiresAt, now());
  return (
    <CustomerPage step="checkout" store={resolvedStore} className="checkout-page">
      <PageHeading title="Checkout" />
      <ol className="checkout-progress" aria-label="Checkout progress">
        <li aria-current="step">1 Review</li>
        <li>2 Pay</li>
        <li>3 Done</li>
      </ol>
      {state.status === "loading" ? (
        <section role="status">
          <h2>Loading checkout</h2>
          <p>Checking your cart…</p>
        </section>
      ) : null}
      {state.status === "empty" ? (
        <section>
          <h2>Your cart is empty</h2>
          <p>Add something from the menu before checking out.</p>
          <Link to="/menu">Browse menu</Link>
        </section>
      ) : null}
      {cart ? (
        <section className="checkout-summary" aria-labelledby="checkout-items">
          <h2 id="checkout-items">Your order</h2>
          <ul className="checkout-items">
            {cart.cart.items.map((item) => (
              <li key={item.cartItemReference}>
                <span className="checkout-items__quantity">{item.quantity} ×</span>
                <span className="checkout-items__name">
                  {item.displayName}
                  {describeConfiguration(item) ? (
                    <span className="checkout-items__options">{describeConfiguration(item)}</span>
                  ) : null}
                  {item.customerNote ? (
                    <span className="checkout-items__note">Note: {item.customerNote}</span>
                  ) : null}
                </span>
                <span className="checkout-items__amount">
                  {item.lineEstimate.status === "Available"
                    ? formatCartMoney(item.lineEstimate.total)
                    : lineEstimateLabel(item.lineEstimate.reasonCode)}
                </span>
              </li>
            ))}
          </ul>
          <Link className="checkout-edit-link" to="/cart">
            Edit cart
          </Link>
        </section>
      ) : null}
      {state.status === "pending" ? <p role="status">Calculating your total…</p> : null}
      {quote ? (
        <section className="checkout-summary checkout-totals" aria-labelledby="quote-heading">
          <h2 id="quote-heading">Total</h2>
          <dl>
            <div>
              <dt>Subtotal</dt>
              <dd>{formatCartMoney(quote.subtotal)}</dd>
            </div>
            {quote.discount.amountMinor !== "0" ? (
              <div>
                <dt>Discount</dt>
                <dd>{formatCartMoney(quote.discount)}</dd>
              </div>
            ) : null}
            <div>
              <dt>Tax</dt>
              <dd>{formatCartMoney(quote.tax)}</dd>
            </div>
            {quote.fee.amountMinor !== "0" ? (
              <div>
                <dt>Fees</dt>
                <dd>{formatCartMoney(quote.fee)}</dd>
              </div>
            ) : null}
            {tipAmount !== null && tipAmount !== "0" ? (
              <div>
                <dt>Tip</dt>
                <dd>{formatMoney(tipAmount, quote.total.currency)}</dd>
              </div>
            ) : null}
            <div className="checkout-totals__total">
              <dt>Total</dt>
              <dd>
                {tipAmount === null
                  ? formatCartMoney(quote.total)
                  : formatMoney(
                      (BigInt(quote.total.amountMinor) + BigInt(tipAmount)).toString(),
                      quote.total.currency,
                    )}
              </dd>
            </div>
          </dl>
          {quoteExpired ? (
            <div role="alert">
              <p>These prices expired. Refresh to price your order again.</p>
              <button
                type="button"
                disabled={detailsLocked || sessionState.status !== "idle"}
                onClick={() => void controller.quote()}
              >
                Refresh prices
              </button>
            </div>
          ) : (
            <p className="checkout-totals__validity">
              {remaining === null ? "" : `Prices confirmed for ${remaining}.`}
            </p>
          )}
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
          {[
            ...quote.blockingReasons.map((code) => quoteIssueMessage(code, true)),
            ...quote.warnings.map((code) => quoteIssueMessage(code, false)),
          ].map((message, index) => (
            <p className="cart-warning" key={`${index}:${message}`}>
              {message}
            </p>
          ))}
        </section>
      ) : null}
      {cart &&
      quote === null &&
      ["conflict", "validation", "unavailable", "quote-expired"].includes(state.status) ? (
        <section role="alert" className="checkout-attention">
          <h2>Prices need a refresh</h2>
          <p>
            {state.status === "quote-expired"
              ? "Your previous prices expired. Refresh to price your order again."
              : state.status === "conflict"
                ? "Your cart changed. Refresh to price the current cart."
                : state.status === "validation"
                  ? "Something in your cart can’t be ordered as selected. Review your cart, then refresh."
                  : "We couldn’t price your order just now. Try again in a moment."}
          </p>
          <button
            ref={quoteAction}
            disabled={detailsLocked || sessionState.status !== "idle"}
            type="button"
            onClick={() => void controller.quote()}
          >
            Refresh prices
          </button>
        </section>
      ) : null}
      {["offline", "session-expired", "outcome-unknown"].includes(state.status) ? (
        <section role="alert" className="checkout-attention">
          <h2>Checkout needs attention</h2>
          <p>
            {state.status === "offline"
              ? "You’re offline. Reconnect to continue; nothing will be submitted automatically."
              : state.status === "outcome-unknown"
                ? "We couldn’t confirm your prices. Retry to continue without creating a second order."
                : "Your session ended. Scan the location QR code again to continue."}
          </p>
          {"canRetry" in state && state.canRetry ? (
            <button
              type="button"
              disabled={state.status === "offline"}
              onClick={() => void controller.retry()}
            >
              Retry pricing
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
          ref={detailsForm}
          now={now}
          selection={detailsSelection}
          onBusyChange={setDetailsLocked}
          onReadyChange={setReadyDetails}
          onSubmittableChange={setDetailsSubmittable}
        />
      ) : null}
      <section className="checkout-boundary checkout-tip" aria-labelledby="checkout-tip-heading">
        <h2 id="checkout-tip-heading">Tip</h2>
        <div className="checkout-tip__choices" role="group" aria-label="Tip amount">
          {tipPresets.map((percent) => {
            const amount =
              quote === null ? null : percentOfMinor(quote.subtotal.amountMinor, percent);
            return (
              <button
                key={percent}
                type="button"
                aria-pressed={tipChoice === percent}
                disabled={sessionState.status !== "idle" || state.status !== "ready"}
                onClick={() => setTipChoice(percent)}
              >
                {percent === 0 ? "No tip" : `${percent}%`}
                {amount !== null && percent !== 0 ? (
                  <span>{formatMoney(amount, quote?.subtotal.currency ?? "CAD")}</span>
                ) : null}
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={tipChoice === "custom"}
            disabled={sessionState.status !== "idle" || state.status !== "ready"}
            onClick={() => {
              setTipChoice("custom");
              if (customTip === "" && quote !== null && tipChoice !== "custom")
                setCustomTip(
                  minorToText(percentOfMinor(quote.subtotal.amountMinor, tipChoice) ?? "0"),
                );
            }}
          >
            Other
          </button>
        </div>
        <label htmlFor="checkout-tip" className={tipChoice === "custom" ? "" : "sr-only"}>
          Tip (CAD)
        </label>
        <input
          id="checkout-tip"
          className={tipChoice === "custom" ? "" : "sr-only"}
          inputMode="decimal"
          autoComplete="off"
          value={tipChoice === "custom" ? customTip : ""}
          disabled={sessionState.status !== "idle" || state.status !== "ready"}
          onChange={(event) => {
            setTipChoice("custom");
            setCustomTip(event.target.value);
          }}
          aria-invalid={tipChoice === "custom" && customTip !== "" && tipAmount === null}
          aria-describedby="checkout-tip-help"
        />
        <p id="checkout-tip-help" className={tipChoice === "custom" ? "" : "sr-only"}>
          {tipChoice === "custom" && customTip !== "" && tipAmount === null
            ? "Enter a valid amount with up to two decimal places."
            : "Enter an amount in dollars. Your tip is fixed when you continue to payment."}
        </p>
      </section>
      <section className="checkout-continue" aria-label="Payment">
        {sessionState.status === "pending" ? <p role="status">Preparing secure payment…</p> : null}
        {"canRetry" in sessionState ? (
          <p role="alert">
            {sessionState.canRetry
              ? "We could not confirm checkout. Retry to recover the same checkout."
              : "Checkout is unavailable. Review your cart and scan the QR code again if needed."}
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
            className="checkout-continue__button"
            disabled={!canContinue || continueRequested}
            onClick={() => void requestContinue()}
          >
            {quote && tipAmount !== null
              ? `Continue to payment · ${formatMoney(
                  (BigInt(quote.total.amountMinor) + BigInt(tipAmount)).toString(),
                  quote.total.currency,
                )}`
              : "Continue to payment"}
          </button>
        )}
        <p className="checkout-continue__note">
          You’ll enter your card on the next step. Nothing is charged until you confirm.
        </p>
      </section>
    </CustomerPage>
  );
}
