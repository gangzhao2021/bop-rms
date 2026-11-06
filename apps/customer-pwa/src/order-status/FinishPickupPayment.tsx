import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { orderStatusText } from "../journey/messages.js";
import { getCheckoutSessionReference } from "../session/customer-transaction-context.js";
import { paymentConfiguration } from "../payment/payment-configuration.js";
import { ResumePaymentPanel } from "../payment/ResumePaymentPanel.js";
import {
  createSessionPaymentResultClient,
  type SessionPaymentResult,
} from "../payment/session-payment-result-client.js";

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
  const [result, setResult] = useState<SessionPaymentResult | null | "elsewhere">(
    session === null ? "elsewhere" : null,
  );
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
      .catch(() => {
        if (!stopped) setResult("elsewhere");
      });
    return () => {
      stopped = true;
    };
  }, [session, orderReference]);
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
  if (result === null) return null;
  if (result === "elsewhere") return <p>{orderStatusText.progress.unpaidElsewhere}</p>;
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
