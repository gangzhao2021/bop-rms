import { t } from "../i18n/i18n.js";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Stripe, StripeElements } from "@stripe/stripe-js";
import { SlowWaitNote } from "../journey/SlowWaitNote.js";
import {
  captureCustomerCsrfContext,
  markCheckoutCardOffered,
  markCheckoutCardSubmitted,
} from "../session/customer-transaction-context.js";

/** On packed restaurant Wi-Fi the form can be slow; past this the guest is told what they can do. */
export const cardFormSlowAfterMs = 20_000;
/** Long enough for 3-D Secure, after which a guest needs to know not to pay again. */
export const cardSubmitSlowAfterMs = 60_000;

/** What a card form that didn't appear can honestly say: a card may have gone in earlier. */
export const cardFormNotLoadedText = () =>
  t(
    "The secure card form didn’t load. If you already entered your card, ask a staff member to check before paying again. Otherwise try again.",
  );

export interface StripeCardFormProps {
  readonly publishableKey: string;
  /** Approved dedicated payment-return sanitizer origin, never the BOP application origin. */
  readonly returnUrl: string;
  readonly clientSecret: string;
  /**
   * Apple Pay / Google Pay buttons: only when the host confirmed this domain is registered and
   * verified with Stripe. Otherwise the form is card only (plain fallback).
   */
  readonly wallets?: boolean;
  readonly onSubmitted: () => void;
  /**
   * WP-2423 item 2: no card form was ever offered in this tab before this one, so a form that fails
   * to load proves this payment wasn't charged. Elsewhere (coming back to a payment, another card, the
   * table's bill) a card may already be in, and the form says nothing about money.
   */
  readonly firstOffer?: boolean;
  /** Where a guest checks the payment when submitting takes too long, when the page has one. */
  readonly resultPath?: string;
}
/** Stripe owns card inputs. Credential lives only in component/SDK memory. */
export function StripeCardForm({
  publishableKey,
  returnUrl,
  clientSecret,
  wallets = false,
  onSubmitted,
  firstOffer = false,
  resultPath,
}: StripeCardFormProps) {
  const host = useRef<HTMLDivElement>(null);
  const sdk = useRef<{ stripe: Stripe; elements: StripeElements; current: () => boolean } | null>(
    null,
  );
  const flight = useRef(false);
  const [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false);
  // What the guest typed didn't pass; the form itself is fine.
  const [error, setError] = useState(false);
  // The form's script or Stripe refused to load: it is gone, and loading it again can work.
  const [loadFailed, setLoadFailed] = useState(false);
  // Still loading after a long time; it stays in place, and a late answer clears this.
  const [slow, setSlow] = useState(false);
  const [attempt, setAttempt] = useState(0);
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
    markCheckoutCardOffered();
    setReady(false);
    setError(false);
    setLoadFailed(false);
    setSlow(false);
    const watchdog = window.setTimeout(() => {
      if (!disposed) setSlow(true);
    }, cardFormSlowAfterMs);
    const failed = () => {
      window.clearTimeout(watchdog);
      if (disposed) return;
      setReady(false);
      setSlow(false);
      setLoadFailed(true);
    };
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
        const payment = elements.create(
          "payment",
          wallets
            ? {
                paymentMethodOrder: ["apple_pay", "google_pay", "card"],
                wallets: { applePay: "auto", googlePay: "auto" },
              }
            : {
                paymentMethodOrder: ["card"],
                wallets: { applePay: "never", googlePay: "never" },
              },
        );
        cleanup = () => {
          payment.destroy();
          sdk.current = null;
        };
        payment.on("ready", () => {
          window.clearTimeout(watchdog);
          if (!disposed && current()) {
            setSlow(false);
            setLoadFailed(false);
            setReady(true);
          }
        });
        payment.on("loaderror", failed);
        sdk.current = { stripe, elements, current };
        payment.mount(host.current);
      } catch {
        failed();
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(watchdog);
      cleanup?.();
      sdk.current = null;
    };
  }, [publishableKey, returnUrl, clientSecret, wallets, attempt]);
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
      // From here the card may be charged: no page may say this payment charged nothing.
      markCheckoutCardSubmitted();
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
    <section aria-label={t("Secure card payment")}>
      <div ref={host} />
      {!ready && !loadFailed && !slow ? (
        <p role="status">{t("Loading secure card form…")}</p>
      ) : null}
      {error ? (
        <p role="alert">
          {t("We couldn’t prepare your card payment. Check the form and try again.")}
        </p>
      ) : null}
      {loadFailed || slow ? (
        <div className="checkout-attention" role="alert">
          {firstOffer ? (
            <>
              <h2>{t("The secure card form didn’t load")}</h2>
              <p>
                {t(
                  "This payment hasn’t been charged. Try again, or ask a staff member to take your payment.",
                )}
              </p>
            </>
          ) : (
            <p>{cardFormNotLoadedText()}</p>
          )}
          <button
            type="button"
            disabled={!online}
            onClick={() => {
              // A hung script keeps its one pending load, so only a reload starts it again; that
              // page finds the same payment on the result page.
              if (slow) window.location.reload();
              else setAttempt((count) => count + 1);
            }}
          >
            {t("Try again")}
          </button>
        </div>
      ) : null}
      {!online ? <p role="alert">{t("Reconnect to continue payment.")}</p> : null}
      {loadFailed ? null : (
        <button
          className="payment-page__pay"
          type="button"
          disabled={!ready || busy || !online}
          onClick={() => void confirm()}
        >
          {busy ? t("Submitting payment…") : t("Pay securely")}
        </button>
      )}
      <SlowWaitNote active={busy} afterMs={cardSubmitSlowAfterMs}>
        {t("Don’t pay again: ask a staff member to check this payment.")}
        {resultPath === undefined ? null : (
          <>
            {" "}
            <Link to={resultPath}>{t("Check payment result")}</Link>
          </>
        )}
      </SlowWaitNote>
    </section>
  );
}
