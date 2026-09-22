import { useEffect, useRef, useState } from "react";
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe, StripeElements } from "@stripe/stripe-js";
import { captureCustomerCsrfContext } from "../session/customer-transaction-context.js";

export interface StripeCardFormProps {
  readonly publishableKey: string;
  /** Approved dedicated payment-return sanitizer origin, never the BOP application origin. */
  readonly returnUrl: string;
  readonly clientSecret: string;
  readonly onSubmitted: () => void;
}
/** Stripe owns card inputs. Credential lives only in component/SDK memory. */
export function StripeCardForm({
  publishableKey,
  returnUrl,
  clientSecret,
  onSubmitted,
}: StripeCardFormProps) {
  const host = useRef<HTMLDivElement>(null);
  const sdk = useRef<{ stripe: Stripe; elements: StripeElements; current: () => boolean } | null>(
    null,
  );
  const flight = useRef(false);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    const offline = () => setOnline(false),
      connected = () => setOnline(true);
    window.addEventListener("offline", offline);
    window.addEventListener("online", connected);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", connected);
    };
  }, []);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const current = captureCustomerCsrfContext();
    setReady(false);
    setError(false);
    void (async () => {
      try {
        const target = new URL(returnUrl);
        if (
          target.protocol !== "https:" ||
          target.username ||
          target.password ||
          target.search ||
          target.hash ||
          target.hostname === window.location.hostname ||
          !/^pk_(?:test|live)_[A-Za-z0-9]+$/u.test(publishableKey) ||
          !/^pi_[A-Za-z0-9]+_secret_[A-Za-z0-9]+$/u.test(clientSecret)
        )
          throw new Error();
        const stripe = await loadStripe(publishableKey);
        if (disposed || !current()) return;
        if (!stripe || !host.current) throw new Error();
        const elements = stripe.elements({ clientSecret });
        const payment = elements.create("payment", {
          paymentMethodOrder: ["card"],
          wallets: { applePay: "never", googlePay: "never" },
        });
        cleanup = () => {
          payment.destroy();
          sdk.current = null;
        };
        payment.on("ready", () => {
          if (!disposed && current()) setReady(true);
        });
        payment.on("loaderror", () => {
          if (!disposed) {
            setReady(false);
            setError(true);
          }
        });
        sdk.current = { stripe, elements, current };
        payment.mount(host.current);
      } catch {
        if (!disposed) setError(true);
      }
    })();
    return () => {
      disposed = true;
      cleanup?.();
      sdk.current = null;
    };
  }, [publishableKey, returnUrl, clientSecret]);
  const confirm = async () => {
    const active = sdk.current;
    if (!active || !active.current() || !online || flight.current || !ready) return;
    const current = () => sdk.current === active && active.current();
    flight.current = true;
    setBusy(true);
    setError(false);
    try {
      const submitted = await active.elements.submit();
      if (!current()) return;
      if (navigator.onLine === false) return;
      if (submitted.error) {
        setError(true);
        return;
      }
      const result = await active.stripe.confirmPayment({
        elements: active.elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });
      if (!current()) return;
      if (result.error?.type === "validation_error") {
        setError(true);
        return;
      }
      // SDK outcome is never authority for paid state; server reconciliation follows.
      onSubmitted();
    } catch {
      if (current()) onSubmitted();
    } finally {
      flight.current = false;
      if (current()) setBusy(false);
    }
  };
  return (
    <section aria-label="Secure card payment">
      <div ref={host} />
      {!ready && !error ? <p role="status">Loading secure card form…</p> : null}
      {error ? (
        <p role="alert">We could not prepare your card payment. Check the form and try again.</p>
      ) : null}
      {!online ? <p role="alert">Reconnect to continue payment.</p> : null}
      <button type="button" disabled={!ready || busy || !online} onClick={() => void confirm()}>
        {busy ? "Submitting payment…" : "Pay securely"}
      </button>
    </section>
  );
}
