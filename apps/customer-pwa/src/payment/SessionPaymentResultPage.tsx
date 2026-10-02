import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import { formatCartMoney } from "../cart/format-money.js";
import { createSessionPaymentResultClient } from "./session-payment-result-client.js";
import { createSessionPaymentResultController } from "./session-payment-result-controller.js";
export function SessionPaymentResultPage() {
  const [controller] = useState(() =>
    createSessionPaymentResultController(createSessionPaymentResultClient()),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getState,
    controller.getState,
  );
  useEffect(() => {
    void controller.load();
    const offline = () => controller.setOnline(false),
      online = () => controller.setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, [controller]);
  const result = state.status === "ready" ? state.result : null;
  const refresh =
    state.status === "unknown" ||
    (result?.status === "Pending" && result.paymentIntentReference !== null) ||
    result?.status === "Unknown";
  const unknown = state.status === "unknown" || result?.status === "Unknown";
  const unprepared = result?.status === "Pending" && result.paymentIntentReference === null;
  const heading =
    state.status === "loading"
      ? "Verifying payment"
      : state.status === "missing" || state.status === "denied"
        ? "Payment result unavailable"
        : state.status === "offline"
          ? "Connection required"
          : unknown
            ? "Payment result unknown"
            : unprepared
              ? "Payment not prepared"
              : result?.status === "Pending"
                ? "Payment confirmation pending"
                : result?.status === "Succeeded"
                  ? "Payment confirmed"
                  : result?.status === "Failed"
                    ? "Payment failed"
                    : "Payment result unavailable";
  const badge = unknown
    ? "Status not confirmed"
    : (result?.status ??
      (state.status === "loading"
        ? "Checking"
        : state.status === "offline"
          ? "Offline"
          : "Unavailable"));
  const badgeTone = unknown
    ? "warning"
    : result?.status === "Failed"
      ? "danger"
      : result?.status === "Succeeded"
        ? "success"
        : result?.status === "Pending"
          ? "pending"
          : "neutral";
  const alert =
    state.status === "missing" ||
    state.status === "denied" ||
    state.status === "offline" ||
    unknown ||
    result?.status === "Failed";
  return (
    <main id="main-content" className="payment-page payment-result-page">
      <header className="payment-page__header payment-result-page__header">
        <span>BOP</span>
        <strong>Payment result</strong>
        <span>Guest session · exact Store scope required</span>
      </header>
      <nav
        className="payment-page__journey payment-result-page__journey"
        aria-label="Customer checkout journey"
      >
        <Link to="/">Entry</Link>
        <Link to="/menu">Menu</Link>
        <Link to="/cart">Cart</Link>
        <Link to="/checkout">Checkout</Link>
        <span aria-current="page">Payment</span>
      </nav>
      <h1>Check your payment</h1>
      <p className="payment-result-page__intro">
        {unknown
          ? "The payment result is still being confirmed."
          : result?.status === "Failed"
            ? "This payment was not completed."
            : "Payment details come from your current checkout session."}
      </p>
      <section className="payment-result-page__card" aria-labelledby="payment-result-heading">
        <span className="payment-result-page__badge" data-tone={badgeTone}>
          {badge}
        </span>
        <h2 id="payment-result-heading">{heading}</h2>
        <div role={alert ? "alert" : "status"} className="payment-result-page__message">
          {state.status === "loading" ? <p>Verifying payment…</p> : null}
          {state.status === "missing" ? (
            <p>
              This payment cannot be identified in this window. Contact the store to check your
              payment before paying again.
            </p>
          ) : null}
          {state.status === "denied" ? (
            <p>
              This payment is unavailable in your current session. Contact the store to check its
              status.
            </p>
          ) : null}
          {state.status === "offline" ? (
            <p>Reconnect to check your payment. Nothing will restart automatically.</p>
          ) : null}
          {unknown ? (
            <>
              <p>Neither success nor failure is confirmed.</p>
              <p>Check the same payment; do not submit another.</p>
            </>
          ) : null}
          {unprepared ? <p>Payment has not been prepared for this checkout.</p> : null}
          {result?.status === "Pending" && !unprepared ? (
            <p>Payment confirmation is pending. Do not submit another payment.</p>
          ) : null}
          {result?.status === "Succeeded" ? (
            <>
              {result.total ? (
                <p>
                  Paid: <strong>{formatCartMoney(result.total)}</strong>
                </p>
              ) : null}
              {result.orderReference ? (
                <Link to={"/orders/" + result.orderReference}>View order status</Link>
              ) : null}
            </>
          ) : null}
          {result?.status === "Failed" ? (
            <p>Contact the store if you need help with this payment.</p>
          ) : null}
        </div>
        {refresh ? (
          <button
            type="button"
            className="payment-result-page__refresh"
            onClick={() => void controller.refresh()}
          >
            Check payment status
          </button>
        ) : null}
      </section>
      <Link className="payment-result-page__back" to="/checkout">
        Back to checkout
      </Link>
    </main>
  );
}
