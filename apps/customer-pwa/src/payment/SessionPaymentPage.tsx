import { t } from "../i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  CheckoutSessionClientError,
  createCheckoutSessionClient,
} from "../checkout/session-client.js";
import {
  captureCustomerCsrfContext,
  getCheckoutSessionReference,
  getCheckoutTipSelection,
} from "../session/customer-transaction-context.js";
import { formatCartMoney } from "../cart/format-money.js";
import { CustomerPage, PageHeading, type CustomerStoreContext } from "../journey/CustomerPage.js";
import {
  createSessionPaymentClient,
  SessionPaymentClientError,
  type SessionPaymentView,
} from "./session-payment-client.js";
import { SessionPaymentResultPage } from "./SessionPaymentResultPage.js";
import { StripeCardForm } from "./StripeCardForm.js";
import { paymentConfiguration } from "./payment-configuration.js";

/**
 * WP-2423 Q10: only a checkout the server no longer recognises ends the payment page; a timeout,
 * outage or other failure keeps the customer here with a retry.
 */
export function checkoutLoadFailureState(error: unknown): "denied" | "retry" {
  return error instanceof CheckoutSessionClientError &&
    (error.code === "denied" || error.code === "invalid" || error.code === "conflict")
    ? "denied"
    : "retry";
}
export function SessionPaymentPage({
  store,
}: {
  readonly store?: CustomerStoreContext | undefined;
}) {
  const [session] = useState(getCheckoutSessionReference);
  const [tip] = useState(getCheckoutTipSelection);
  // A restored checkout has no page-memory tip. Read its outcome before another payment action.
  return session && !tip ? (
    <SessionPaymentResultPage store={store} />
  ) : (
    <PreparedSessionPaymentPage store={store} />
  );
}
function PreparedSessionPaymentPage({
  store,
}: {
  readonly store?: CustomerStoreContext | undefined;
}) {
  const navigate = useNavigate();
  const [config] = useState(paymentConfiguration);
  const [sessionReference] = useState(getCheckoutSessionReference);
  const [client] = useState(createSessionPaymentClient);
  const [current] = useState(() => captureCustomerCsrfContext());
  const [status, setStatus] = useState<
    | "loading"
    | "ready"
    | "creating"
    | "card"
    | "processing"
    | "unknown"
    | "denied"
    | "retry"
    | "closed"
    /** WP-2423: items ran out after checkout; no order was placed and nothing was charged. */
    | "items_short"
    | "unavailable"
  >("loading");
  // WP-2423 Q10: a failed check of the checkout is retried in place, never a dead end.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [selectedTip] = useState(getCheckoutTipSelection);
  const [payment, setPayment] = useState<SessionPaymentView | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  const flight = useRef(false),
    alive = useRef(true);
  const valid = () =>
    alive.current && current() && getCheckoutSessionReference() === sessionReference;
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    if (!config) setStatus("unavailable");
    else if (
      !sessionReference ||
      !selectedTip ||
      selectedTip.checkoutSessionReference !== sessionReference ||
      !current()
    )
      setStatus("denied");
    else
      void createCheckoutSessionClient()
        .read(sessionReference)
        .then(() => {
          if (!stopped && current()) setStatus("ready");
        })
        .catch((error: unknown) => {
          if (stopped) return;
          setStatus(checkoutLoadFailureState(error));
        });
    return () => {
      stopped = true;
      alive.current = false;
    };
  }, [config, current, sessionReference, selectedTip, loadAttempt]);
  useEffect(() => {
    const offline = () => {
      setOnline(false);
      setSecret(null);
      setStatus((value) => (value === "card" ? "unknown" : value));
    };
    const connected = () => setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", connected);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", connected);
    };
  }, []);
  const prepare = async () => {
    if (!config || !sessionReference || !valid() || !online || flight.current) return;
    if (!selectedTip || selectedTip.checkoutSessionReference !== sessionReference) return;
    flight.current = true;
    setSecret(null);
    setStatus("creating");
    try {
      const result = await client.create(
        sessionReference,
        selectedTip.selectionReference,
        selectedTip.amountMinor,
      );
      if (!valid()) return;
      setPayment(result);
      if (result.creationStatus === "Processing") {
        setStatus("processing");
        return;
      }
      if (config.mode === "simulation") {
        setStatus("card");
        return;
      }
      const credential = await client.handoff(sessionReference);
      if (!valid()) return;
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setStatus("unknown");
        return;
      }
      setSecret(credential);
      setStatus("card");
    } catch (error) {
      if (valid())
        setStatus(
          error instanceof SessionPaymentClientError && error.code === "store_closed"
            ? "closed"
            : error instanceof SessionPaymentClientError && error.code === "items_short"
              ? "items_short"
              : error instanceof SessionPaymentClientError &&
                  (error.code === "denied" || error.code === "conflict")
                ? "denied"
                : "unknown",
        );
    } finally {
      flight.current = false;
    }
  };
  // U1: the amount and the secure card field appear as soon as the checkout is confirmed.
  const autoPrepared = useRef(false);
  useEffect(() => {
    if (status !== "ready" || autoPrepared.current || !online) return;
    autoPrepared.current = true;
    void prepare();
    // prepare reads refs and page-memory selections; the status transition is the trigger.
  }, [status, online]);
  const simulate = async (outcome: "approve" | "decline" = "approve") => {
    if (
      config?.mode !== "simulation" ||
      !sessionReference ||
      !selectedTip ||
      !valid() ||
      !online ||
      flight.current
    )
      return;
    flight.current = true;
    setStatus("creating");
    try {
      await (outcome === "approve" ? client.simulate : client.simulateDecline)(
        sessionReference,
        selectedTip.selectionReference,
        selectedTip.amountMinor,
      );
      if (valid()) void navigate("/checkout/result", { replace: true });
    } catch {
      if (valid()) setStatus("unknown");
    } finally {
      flight.current = false;
    }
  };
  const submitted = () => {
    setSecret(null);
    if (valid()) void navigate("/checkout/result", { replace: true });
  };
  const demo = config?.mode === "simulation";
  return (
    <CustomerPage step="payment" store={store} className="payment-page">
      <PageHeading title={demo ? t("DEMO payment") : t("Secure payment")}>
        {demo ? <p>{t("Internal testing only. No real money is charged.")}</p> : null}
      </PageHeading>
      <ol className="checkout-progress" aria-label={t("Checkout progress")}>
        <li>{t("Review")}</li>
        <li aria-current="step">{t("Pay")}</li>
        <li>{t("Done")}</li>
      </ol>
      {status === "loading" ? <p role="status">{t("Loading checkout…")}</p> : null}
      {status === "unavailable" ? (
        <section className="payment-page__unavailable" role="alert">
          <h2>{t("Online payment is unavailable")}</h2>
          <p>{t("Card payment isn’t set up at this location yet. Ask staff how to pay.")}</p>
        </section>
      ) : null}
      {status === "denied" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("This checkout has ended")}</h2>
          <p>
            {t(
              "You haven’t been charged for it. Go back to your cart to check out again, or ask a staff member for help.",
            )}
          </p>
          <Link to="/cart">{t("Back to your cart")}</Link>
        </section>
      ) : null}
      {status === "retry" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("We couldn’t load your payment")}</h2>
          <p>{t("You haven’t been charged. Check your connection and try again.")}</p>
          <button
            type="button"
            disabled={!online}
            onClick={() => {
              setStatus("loading");
              setLoadAttempt((count) => count + 1);
            }}
          >
            {t("Try again")}
          </button>
        </section>
      ) : null}
      {status === "closed" ? (
        <p role="alert">
          {t(
            "The store stopped taking orders before payment started (it closed, or the kitchen stopped taking orders for today), so you haven’t been charged. To add something, ask a staff member.",
          )}
        </p>
      ) : null}
      {status === "items_short" ? (
        <section className="checkout-attention" role="alert">
          <h2>{t("Some items just ran out")}</h2>
          <p>
            {t(
              "Part of your order sold out while we were getting it ready, so we didn’t place it and you haven’t been charged. Go back to your cart to change your order.",
            )}
          </p>
          <Link to="/cart">{t("Back to your cart")}</Link>
        </section>
      ) : null}
      {status !== "denied" &&
      status !== "retry" &&
      status !== "closed" &&
      status !== "items_short" &&
      status !== "unavailable" &&
      status !== "loading" ? (
        <section className="payment-page__amount" aria-label={t("Amount")}>
          <dl>
            {selectedTip && selectedTip.amountMinor !== "0" ? (
              <div>
                <dt>{t("Tip")}</dt>
                <dd>
                  {formatCartMoney({ amountMinor: selectedTip.amountMinor, currency: "CAD" })}
                </dd>
              </div>
            ) : null}
            <div className="payment-page__total">
              <dt>{t("Total to pay")}</dt>
              <dd>{payment ? formatCartMoney(payment.total) : "Calculating…"}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {status === "creating" ? <p role="status">{t("Preparing your payment…")}</p> : null}
      {status === "processing" || status === "unknown" ? (
        <section role="status" className="checkout-attention">
          <p>{t("We couldn’t confirm your payment is ready. Check the same payment again.")}</p>
          <Link to="/checkout/result">{t("Check payment result")}</Link>
          <button type="button" disabled={!online} onClick={() => void prepare()}>
            {t("Check payment readiness")}
          </button>
        </section>
      ) : null}
      {status === "card" && demo ? (
        <>
          <button
            className="payment-page__pay"
            type="button"
            disabled={!online}
            onClick={() => void simulate()}
          >
            {t("Confirm simulated payment")}
          </button>
          {/* WP-2423 Q20: internal testing of a declined card and paying with another card. */}
          <button type="button" disabled={!online} onClick={() => void simulate("decline")}>
            {t("Simulate a declined card (test only)")}
          </button>
        </>
      ) : null}
      {status === "card" && secret && config?.mode === "stripe" ? (
        <StripeCardForm {...config} clientSecret={secret} onSubmitted={submitted} />
      ) : null}
      {!online ? (
        <p role="alert">{t("Reconnect to continue. Payment will not restart automatically.")}</p>
      ) : null}
      <Link className="payment-page__back" to="/checkout">
        {t("Back to checkout")}
      </Link>
    </CustomerPage>
  );
}
