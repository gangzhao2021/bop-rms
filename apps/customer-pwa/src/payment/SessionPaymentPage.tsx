import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { createCheckoutSessionClient } from "../checkout/session-client.js";
import {
  captureCustomerCsrfContext,
  getCheckoutSessionReference,
  getCheckoutTipSelection,
} from "../session/customer-transaction-context.js";
import { formatCartMoney } from "../cart/format-money.js";
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
export function SessionPaymentPage() {
  const [session] = useState(getCheckoutSessionReference);
  const [tip] = useState(getCheckoutTipSelection);
  // A restored checkout has no page-memory tip. Read its outcome before another payment action.
  return session && !tip ? <SessionPaymentResultPage /> : <PreparedSessionPaymentPage />;
}
function PreparedSessionPaymentPage() {
  const navigate = useNavigate();
  const [config] = useState(configuration);
  const [sessionReference] = useState(getCheckoutSessionReference);
  const [client] = useState(createSessionPaymentClient);
  const [current] = useState(() => captureCustomerCsrfContext());
  const [status, setStatus] = useState<
    "loading" | "ready" | "creating" | "card" | "processing" | "unknown" | "denied" | "unavailable"
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
          error instanceof SessionPaymentClientError &&
            (error.code === "denied" || error.code === "conflict")
            ? "denied"
            : "unknown",
        );
    } finally {
      flight.current = false;
    }
  };
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
  return (
    <main id="main-content" className="payment-page">
      <header className="payment-page__header">
        <span>BOP</span>
        <strong>{config?.mode === "simulation" ? "DEMO payment" : "Payment"}</strong>
        <span>Guest session · exact Store scope required</span>
      </header>
      <nav className="payment-page__journey" aria-label="Customer checkout journey">
        <Link to="/">Entry</Link>
        <Link to="/menu">Menu</Link>
        <Link to="/cart">Cart</Link>
        <Link to="/checkout">Checkout</Link>
        <span aria-current="page">Payment</span>
      </nav>
      <h1>{config?.mode === "simulation" ? "DEMO payment" : "Secure payment"}</h1>
      {config?.mode === "simulation" ? (
        <p>Internal testing only. No real money is charged.</p>
      ) : null}
      {status === "loading" ? <p role="status">Loading checkout…</p> : null}
      {status === "unavailable" ? (
        <section className="payment-page__unavailable" role="alert">
          <h2>Online payment is unavailable</h2>
          <p>No authorized payment details are available.</p>
          <dl aria-label="Payment details unavailable">
            <div>
              <dt>Payment amount</dt>
              <dd>Unavailable</dd>
            </div>
            <div>
              <dt>Selected tip</dt>
              <dd>Unavailable</dd>
            </div>
            <div>
              <dt>Allowed method</dt>
              <dd>Unavailable</dd>
            </div>
            <div>
              <dt>Secure card field</dt>
              <dd>Unavailable</dd>
            </div>
            <div>
              <dt>Processing notice</dt>
              <dd>Unavailable</dd>
            </div>
          </dl>
        </section>
      ) : null}
      {status === "denied" ? (
        <p role="alert">This checkout is unavailable. Return to checkout to continue.</p>
      ) : null}
      {selectedTip && status !== "denied" && status !== "unavailable" ? (
        <p>
          Selected tip:{" "}
          <strong>
            {formatCartMoney({ amountMinor: selectedTip.amountMinor, currency: "CAD" })}
          </strong>
        </p>
      ) : null}
      {status === "ready" ? (
        <button type="button" disabled={!online} onClick={() => void prepare()}>
          Review payment total
        </button>
      ) : null}
      {payment ? (
        <p>
          Total to pay: <strong>{formatCartMoney(payment.total)}</strong>
        </p>
      ) : null}
      {status === "creating" ? <p role="status">Preparing your payment…</p> : null}
      {status === "processing" || status === "unknown" ? (
        <section role="status">
          <p>Payment readiness is not confirmed. Check the same payment again.</p>
          <Link to="/checkout/result">Check payment result</Link>
          <button type="button" disabled={!online} onClick={() => void prepare()}>
            Check payment readiness
          </button>
        </section>
      ) : null}
      {status === "card" && config?.mode === "simulation" ? (
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
      <Link to="/checkout">Back to checkout</Link>
    </main>
  );
}
