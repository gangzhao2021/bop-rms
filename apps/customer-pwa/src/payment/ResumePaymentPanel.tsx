import { useRef, useState } from "react";
import { formatCartMoney } from "../cart/format-money.js";
import { formatClockTime } from "../journey/format.js";
import {
  createSessionPaymentClient,
  SessionPaymentClientError,
  type SessionPaymentView,
} from "./session-payment-client.js";
import { StripeCardForm } from "./StripeCardForm.js";
import type { RetryCardConfiguration } from "./RetryCardPanel.js";

type ResumeState =
  | { readonly step: "offer" }
  | { readonly step: "opening" }
  | { readonly step: "simulated" }
  | { readonly step: "card"; readonly secret: string }
  | { readonly step: "submitting" }
  | { readonly step: "stopped"; readonly reason: "window_ended" | "unknown" };

/** Plain words for why the payment can't be finished here; never codes. */
export const resumeStoppedText = {
  window_ended:
    "The time to pay for this has ended, so you haven’t been charged. Ask staff if you still want it.",
  unknown: "We couldn’t open your payment. Check your connection and try again.",
} as const;

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): the guest started paying, then left the
 * page (reload, another tab). They finish the same payment here — same amount and tip, same attempt;
 * nothing is charged twice. Shown only while the payment window is open.
 */
export function ResumePaymentPanel({
  checkoutSessionReference,
  total,
  payBy,
  configuration,
  online,
  onSettled,
}: {
  readonly checkoutSessionReference: string;
  readonly total: SessionPaymentView["total"] | null;
  readonly payBy: string | null;
  readonly configuration: RetryCardConfiguration | null;
  readonly online: boolean;
  /** Re-read the payment result after the card was submitted (or it turned out settled). */
  readonly onSettled: () => void;
}) {
  const [client] = useState(createSessionPaymentClient);
  const [state, setState] = useState<ResumeState>({ step: "offer" });
  const flight = useRef(false);
  const stop = (error: unknown) => {
    if (
      error instanceof SessionPaymentClientError &&
      (error.code === "already_paid" || error.code === "retry_pending" || error.code === "conflict")
    ) {
      setState({ step: "offer" });
      onSettled();
      return;
    }
    setState({
      step: "stopped",
      reason:
        error instanceof SessionPaymentClientError && error.code === "window_ended"
          ? "window_ended"
          : "unknown",
    });
  };
  const open = async () => {
    if (configuration === null || !online || flight.current) return;
    flight.current = true;
    setState({ step: "opening" });
    try {
      const attempt = await client.resume(checkoutSessionReference);
      if (attempt.creationStatus === "Processing") {
        setState({ step: "offer" });
        onSettled();
        return;
      }
      if (configuration.mode === "simulation") setState({ step: "simulated" });
      else setState({ step: "card", secret: await client.handoff(checkoutSessionReference) });
    } catch (error) {
      stop(error);
    } finally {
      flight.current = false;
    }
  };
  const simulate = async (outcome: "approve" | "decline") => {
    if (!online || flight.current) return;
    flight.current = true;
    setState({ step: "submitting" });
    try {
      await client.simulateResume(checkoutSessionReference, outcome);
      setState({ step: "offer" });
      onSettled();
    } catch (error) {
      stop(error);
    } finally {
      flight.current = false;
    }
  };
  if (configuration === null) return null;
  return (
    <section className="payment-retry" aria-labelledby="payment-resume-heading">
      <h3 id="payment-resume-heading">Finish paying</h3>
      <p>
        {total ? (
          <>
            Amount to pay: <strong>{formatCartMoney(total)}</strong>.{" "}
          </>
        ) : null}
        {payBy
          ? `Pay by ${formatClockTime(payBy)}, or it is cancelled and nobody is charged.`
          : null}
      </p>
      {state.step === "offer" ? (
        <button
          type="button"
          className="payment-result-page__retry"
          disabled={!online}
          onClick={() => void open()}
        >
          Finish paying
        </button>
      ) : null}
      {state.step === "opening" ? <p role="status">Opening your payment…</p> : null}
      {state.step === "submitting" ? <p role="status">Checking your card…</p> : null}
      {state.step === "simulated" ? (
        <div className="payment-retry__simulated">
          <p>Internal testing only. No real money is charged.</p>
          <button
            type="button"
            className="payment-result-page__retry"
            disabled={!online}
            onClick={() => void simulate("approve")}
          >
            Confirm simulated payment
          </button>
          <button
            type="button"
            className="payment-retry__secondary"
            disabled={!online}
            onClick={() => void simulate("decline")}
          >
            Simulate a declined card (test only)
          </button>
        </div>
      ) : null}
      {state.step === "card" && configuration.mode === "stripe" ? (
        <StripeCardForm
          publishableKey={configuration.publishableKey}
          returnUrl={configuration.returnUrl}
          wallets={configuration.wallets === true}
          clientSecret={state.secret}
          onSubmitted={() => {
            setState({ step: "offer" });
            onSettled();
          }}
        />
      ) : null}
      {state.step === "stopped" ? (
        <div role="alert" className="payment-retry__stopped">
          <p>{resumeStoppedText[state.reason]}</p>
          {state.reason === "unknown" ? (
            <button
              type="button"
              className="payment-result-page__retry"
              disabled={!online}
              onClick={() => setState({ step: "offer" })}
            >
              Try again
            </button>
          ) : null}
        </div>
      ) : null}
      {!online ? <p role="alert">Reconnect to finish paying.</p> : null}
    </section>
  );
}
