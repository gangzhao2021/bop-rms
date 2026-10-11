import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { createCheckoutSessionClient } from "../checkout/session-client.js";
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

function configuration() {
  if (
    import.meta.env.VITE_BOP_INTERNAL_SIMULATED_PAYMENT === "1" &&
    typeof window !== "undefined" &&
    window.location.origin === "https://127.0.0.1:4443"
  )
    return { mode: "simulation" as const };
  const key: unknown = import.meta.env.VITE_BOP_STRIPE_PUBLISHABLE_KEY;
  const target: unknown = import.meta.env.VITE_BOP_PAYMENT_RETURN_URL;
  if (
    typeof key !== "string" ||
    typeof target !== "string" ||
    !/^pk_(?:test|live)_[A-Za-z0-9]+$/u.test(key)
  )
    return null;
  try {
    const url = new URL(target);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (typeof window !== "undefined" && url.hostname === window.location.hostname)
    )
      return null;
    return { mode: "stripe" as const, publishableKey: key, returnUrl: url.href };
  } catch {
    return null;
  }
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
  const [config] = useState(configuration);
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
    | "closed"
    | "unavailable"
  >("loading");
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
        .catch(() => {
          if (!stopped) setStatus("denied");
        });
    return () => {
      stopped = true;
      alive.current = false;
    };
  }, [config, current, sessionReference, selectedTip]);
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
  const simulate = async () => {
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
      await client.simulate(
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
      <PageHeading title={demo ? "DEMO payment" : "Secure payment"}>
        {demo ? <p>Internal testing only. No real money is charged.</p> : null}
      </PageHeading>
      <ol className="checkout-progress" aria-label="Checkout progress">
        <li>1 Review</li>
        <li aria-current="step">2 Pay</li>
        <li>3 Done</li>
      </ol>
      {status === "loading" ? <p role="status">Loading checkout…</p> : null}
      {status === "unavailable" ? (
        <section className="payment-page__unavailable" role="alert">
          <h2>Online payment is unavailable</h2>
          <p>Card payment isn’t set up at this location yet. Ask staff how to pay.</p>
        </section>
      ) : null}
      {status === "denied" ? (
        <p role="alert">This checkout is no longer available. Return to checkout to continue.</p>
      ) : null}
      {status === "closed" ? (
        <p role="alert">
          The store stopped taking orders before payment started, so you haven’t been charged. Check
          the store’s hours or ask staff.
        </p>
      ) : null}
      {status !== "denied" &&
      status !== "closed" &&
      status !== "unavailable" &&
      status !== "loading" ? (
        <section className="payment-page__amount" aria-label="Amount">
          <dl>
            {selectedTip && selectedTip.amountMinor !== "0" ? (
              <div>
                <dt>Tip</dt>
                <dd>
                  {formatCartMoney({ amountMinor: selectedTip.amountMinor, currency: "CAD" })}
                </dd>
              </div>
            ) : null}
            <div className="payment-page__total">
              <dt>Total to pay</dt>
              <dd>{payment ? formatCartMoney(payment.total) : "Calculating…"}</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {status === "creating" ? <p role="status">Preparing your payment…</p> : null}
      {status === "processing" || status === "unknown" ? (
        <section role="status" className="checkout-attention">
          <p>We couldn’t confirm your payment is ready. Check the same payment again.</p>
          <Link to="/checkout/result">Check payment result</Link>
          <button type="button" disabled={!online} onClick={() => void prepare()}>
            Check payment readiness
          </button>
        </section>
      ) : null}
      {status === "card" && demo ? (
        <button type="button" disabled={!online} onClick={() => void simulate()}>
          Confirm simulated payment
        </button>
      ) : null}
      {status === "card" && secret && config?.mode === "stripe" ? (
        <StripeCardForm {...config} clientSecret={secret} onSubmitted={submitted} />
      ) : null}
      {!online ? (
        <p role="alert">Reconnect to continue. Payment will not restart automatically.</p>
      ) : null}
      <Link className="payment-page__back" to="/checkout">
        Back to checkout
      </Link>
    </CustomerPage>
  );
}
