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
  return (
    <main id="main-content" className="payment-page">
      <h1>Verify your payment</h1>
      {state.status === "loading" ? <p role="status">Verifying payment…</p> : null}
      {state.status === "missing" ? (
        <p role="alert">
          This payment cannot be identified in this window. Contact the store to check your payment
          before paying again.
        </p>
      ) : null}
      {state.status === "denied" ? (
        <p role="alert">
          This payment is unavailable in your current session. Contact the store to check its
          status.
        </p>
      ) : null}
      {state.status === "offline" ? (
        <p role="alert">Reconnect to check your payment. Nothing will restart automatically.</p>
      ) : null}
      {state.status === "unknown" || result?.status === "Unknown" ? (
        <p role="alert">Your payment result is not yet known. Check again before paying again.</p>
      ) : null}
      {result?.status === "Pending" ? (
        result.paymentIntentReference === null ? (
          <section role="status">
            <p>Payment has not been prepared for this checkout.</p>
            <Link to="/checkout">Return to checkout</Link>
          </section>
        ) : (
          <p role="status">Payment confirmation is pending.</p>
        )
      ) : null}
      {result?.status === "Succeeded" ? (
        <section role="status">
          <h2>Payment confirmed</h2>
          {result.total ? (
            <p>
              Paid: <strong>{formatCartMoney(result.total)}</strong>
            </p>
          ) : null}
          {result.orderReference ? (
            <Link to={"/orders/" + result.orderReference}>View order status</Link>
          ) : null}
        </section>
      ) : null}
      {result?.status === "Failed" ? (
        <section role="alert">
          <h2>Payment failed</h2>
          <p>Contact the store if you need help with this payment.</p>
        </section>
      ) : null}
      {refresh ? (
        <button type="button" onClick={() => void controller.refresh()}>
          Check payment status
        </button>
      ) : null}
    </main>
  );
}
