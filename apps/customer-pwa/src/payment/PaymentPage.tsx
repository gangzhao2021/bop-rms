import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import {
  createPaymentController,
  createUnavailablePaymentClient,
  type PaymentController,
} from "./payment-controller.js";
import type { PaymentMode } from "./types.js";

export function PaymentPage({
  mode,
  controller: provided,
}: {
  readonly mode: PaymentMode;
  readonly controller?: PaymentController;
}) {
  const [controller] = useState(
    () => provided ?? createPaymentController(mode, createUnavailablePaymentClient()),
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
    };
  }, [controller]);
  const result = mode === "result";
  return (
    <main id="main-content" className="payment-page">
      <header>
        <p className="cart-page__eyebrow">{result ? "Payment result" : "Secure payment"}</p>
        <h1>{result ? "Verify your payment" : "Continue to payment"}</h1>
        <p>Payment and Order facts come only from an approved server adapter.</p>
      </header>

      {state.status === "loading" ? (
        <section role="status">
          <h2>{result ? "Verifying payment" : "Loading payment"}</h2>
          <p>No redirect or callback result is trusted.</p>
        </section>
      ) : null}
      {state.status === "ready" ? (
        <section>
          <h2>Online card</h2>
          <p>The server will determine the exact amount and allowed method.</p>
          <button type="button" onClick={() => void controller.start()}>
            Start secure payment
          </button>
        </section>
      ) : null}
      {state.status === "provider-unavailable" ? (
        <section role="alert">
          <h2>Payment is not available</h2>
          <p>The Provider IDR and public Guest Payment adapter are not available.</p>
          <p>No Payment request was sent and no Order was created.</p>
        </section>
      ) : null}
      {state.status === "context-missing" ? (
        <section role="alert">
          <h2>Payment context is missing</h2>
          <p>Return to checkout. This clean route does not accept callback claims from the URL.</p>
        </section>
      ) : null}
      {state.status === "offline" ? (
        <section role="alert">
          <h2>Payment requires a connection</h2>
          <p>Offline is read-only. Nothing will replay when the connection returns.</p>
        </section>
      ) : null}
      {state.status === "pending" ? (
        <section role="status">
          <h2>Payment pending</h2>
          <p>Keep this page open while authoritative status is verified.</p>
        </section>
      ) : null}
      {state.status === "failed" ? (
        <section role="alert">
          <h2>Payment failed</h2>
          <p>Safe reason: {state.safeReasonCode}</p>
          <p>No Order confirmation is assumed.</p>
        </section>
      ) : null}
      {state.status === "unknown" ? (
        <section role="alert">
          <h2>Payment result unknown</h2>
          <p>Neither success nor failure is assumed.</p>
          <button type="button" onClick={() => void controller.retry()}>
            Verify the same payment operation
          </button>
        </section>
      ) : null}
      {state.status === "succeeded" ? (
        <section role="status">
          <h2>Payment confirmed</h2>
          <p>An authoritative Order reference is available.</p>
          <Link to={`/orders/${state.orderReference}`}>View order status</Link>
        </section>
      ) : null}
      {"operationReference" in state ? (
        <p className="payment-page__operation">
          Operation reference <code>{state.operationReference}</code>
        </p>
      ) : null}

      <section className="payment-page__boundary">
        <h2>Payment boundary</h2>
        <p>Cash, manual card entry, Staff Terminal and raw Provider UI are not offered here.</p>
      </section>
      <Link to="/checkout">Back to checkout</Link>
    </main>
  );
}
