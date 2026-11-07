import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { orderStatusText } from "../journey/messages.js";
import { getCheckoutSessionReference } from "../session/customer-transaction-context.js";
import { paymentConfiguration } from "../payment/payment-configuration.js";
import { ResumePaymentPanel } from "../payment/ResumePaymentPanel.js";
import {
  createSessionPaymentResultClient,
  type SessionPaymentResult,
} from "../payment/session-payment-result-client.js";
import { SessionPaymentClientError } from "../payment/session-payment-client.js";

/**
 * WP-2423 M18 review: a failed read of the payment result. Only an answer that this checkout is
 * not this phone's (refused or not found) means "another phone"; a network or server failure is
 * an outage the guest can retry, never read as the wrong device.
 */
export function finishPaymentReadFailure(error: unknown): "elsewhere" | "unchecked" {
  return error instanceof SessionPaymentClientError &&
    (error.code === "denied" || error.code === "invalid")
    ? "elsewhere"
    : "unchecked";
}

/**
 * WP-2423 M18: which unpaid pickup the checkout on this phone can still finish. Only the checkout
 * that placed this order, with its payment still open, offers the same attempt again.
 */
export function canFinishPaymentHere(
  result: Pick<SessionPaymentResult, "status" | "paymentIntentReference" | "orderReference">,
  orderReference: string,
): boolean {
  return (
    result.status === "Pending" &&
    result.paymentIntentReference !== null &&
    result.orderReference === orderReference
  );
}

/**
 * WP-2423 M18: "Finish paying" on the order page. The same payment (same amount, same attempt) is
 * resumed on the phone that placed the order; another phone is told where it can be finished.
 */
export function FinishPickupPayment({ orderReference }: { readonly orderReference: string }) {
  const navigate = useNavigate();
  const [session] = useState(getCheckoutSessionReference);
  const [result, setResult] = useState<
    SessionPaymentResult | null | "elsewhere" | "unchecked" | "rechecking"
  >(session === null ? "elsewhere" : null);
  /** Each try of the read (Try again, or the phone coming back online after a failed read). */
  const [attempt, setAttempt] = useState(0);
  const [configuration] = useState(paymentConfiguration);
  const [online, setOnline] = useState(
    () => typeof navigator === "undefined" || navigator.onLine !== false,
  );
  useEffect(() => {
    if (session === null) return;
    let stopped = false;
    void createSessionPaymentResultClient()
      .read(session)
      .then((answer) => {
        if (!stopped)
          setResult(canFinishPaymentHere(answer, orderReference) ? answer : "elsewhere");
      })
      .catch((error: unknown) => {
        if (!stopped) setResult(finishPaymentReadFailure(error));
      });
    return () => {
      stopped = true;
    };
  }, [session, orderReference, attempt]);
  const retry = () => {
    setResult("rechecking");
    setAttempt((value) => value + 1);
  };
  const resultNow = useRef(result);
  resultNow.current = result;
  useEffect(() => {
    const offline = () => setOnline(false),
      connected = () => {
        setOnline(true);
        // Back online after a read that failed: read again by itself.
        if (resultNow.current === "unchecked") retry();
      };
    window.addEventListener("offline", offline);
    window.addEventListener("online", connected);
    return () => {
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", connected);
    };
  }, []);
  if (result === null) return null;
  if (result === "elsewhere") return <p>{orderStatusText.progress.unpaidElsewhere}</p>;
  if (result === "unchecked" || result === "rechecking")
    return (
      <div role="status">
        <p>{orderStatusText.progress.paymentUnchecked}</p>
        <button
          type="button"
          className="order-status__retry"
          disabled={result === "rechecking"}
          onClick={retry}
        >
          {orderStatusText.progress.paymentUncheckedRetry}
        </button>
      </div>
    );
  return (
    <ResumePaymentPanel
      checkoutSessionReference={result.checkoutSessionReference}
      total={result.total}
      payBy={result.payBy}
      configuration={configuration}
      online={online}
      onSettled={() => void navigate("/checkout/result")}
    />
  );
}
