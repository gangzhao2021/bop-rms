import { t } from "../i18n/i18n.js";
import { useRef, useState } from "react";
import { formatCartMoney } from "../cart/format-money.js";
import {
  createSessionPaymentClient,
  SessionPaymentClientError,
  type SessionPaymentView,
} from "./session-payment-client.js";
import { StripeCardForm } from "./StripeCardForm.js";

export type RetryCardConfiguration =
  | { readonly mode: "simulation" }
  | {
      readonly mode: "stripe";
      readonly publishableKey: string;
      readonly returnUrl: string;
      readonly wallets?: boolean;
    };

type RetryState =
  | { readonly step: "offer" }
  | { readonly step: "opening" }
  | { readonly step: "simulated" }
  | { readonly step: "card"; readonly secret: string }
  | { readonly step: "submitting" }
  | {
      readonly step: "stopped";
      readonly reason: "retry_limit" | "window_ended" | "retry_pending" | "unknown";
    };

/** Plain words for why another card cannot be tried; never codes. */
export const retryStoppedText = {
  get retry_limit() {
    return t("This order has reached the limit of card tries. Ask staff to pay at the counter.");
  },
  get window_ended() {
    return t(
      "The time to pay for this order has ended, so you haven’t been charged. Ask staff for help.",
    );
  },
  get retry_pending() {
    return t("Your last card is still being checked. Check the payment status again.");
  },
  get unknown() {
    return t("We couldn’t open another card payment. Check your connection and try again.");
  },
} as const;

/**
 * WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): after a declined card the customer can pay the same order
 * with another card, within the same payment window. The server opens a new attempt on the same
 * payment; the order, amount and tip stay as they were, and nothing is charged twice.
 */
export function RetryCardPanel({
  checkoutSessionReference,
  total,
  configuration,
  online,
  onSettled,
}: {
  readonly checkoutSessionReference: string;
  readonly total: SessionPaymentView["total"] | null;
  readonly configuration: RetryCardConfiguration | null;
  readonly online: boolean;
  /** Re-read the payment result after a card was submitted (or the payment turned out paid). */
  readonly onSettled: () => void;
}) {
  const [client] = useState(createSessionPaymentClient);
  const [state, setState] = useState<RetryState>({ step: "offer" });
  const flight = useRef(false);
  const stop = (error: unknown) => {
    if (error instanceof SessionPaymentClientError && error.code === "already_paid") {
      onSettled();
      return;
    }
    setState({
      step: "stopped",
      reason:
        error instanceof SessionPaymentClientError &&
        (error.code === "retry_limit" ||
          error.code === "window_ended" ||
          error.code === "retry_pending")
          ? error.code
          : "unknown",
    });
  };
  const open = async () => {
    if (configuration === null || !online || flight.current) return;
    if (configuration.mode === "simulation") {
      setState({ step: "simulated" });
      return;
    }
    flight.current = true;
    setState({ step: "opening" });
    try {
      const attempt = await client.retry(checkoutSessionReference);
      if (attempt.creationStatus === "Processing") {
        setState({ step: "stopped", reason: "retry_pending" });
        return;
      }
      setState({ step: "card", secret: await client.handoff(checkoutSessionReference) });
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
      await client.simulateRetry(checkoutSessionReference, outcome);
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
    <section className="payment-retry" aria-labelledby="payment-retry-heading">
      <h3 id="payment-retry-heading">{t("Pay with another card")}</h3>
      {total ? (
        <p>
          {t("Amount to pay:")} <strong>{formatCartMoney(total)}</strong>
        </p>
      ) : null}
      {state.step === "offer" ? (
        <button
          type="button"
          className="payment-result-page__retry"
          disabled={!online}
          onClick={() => void open()}
        >
          {t("Try another card")}
        </button>
      ) : null}
      {state.step === "opening" ? <p role="status">{t("Opening a new card payment…")}</p> : null}
      {state.step === "submitting" ? <p role="status">{t("Checking your card…")}</p> : null}
      {state.step === "simulated" ? (
        <div className="payment-retry__simulated">
          <p>{t("Internal testing only. No real money is charged.")}</p>
          <button
            type="button"
            className="payment-result-page__retry"
            disabled={!online}
            onClick={() => void simulate("approve")}
          >
            {t("Confirm simulated payment")}
          </button>
          <button
            type="button"
            className="payment-retry__secondary"
            disabled={!online}
            onClick={() => void simulate("decline")}
          >
            {t("Simulate a declined card (test only)")}
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
          <p>{retryStoppedText[state.reason]}</p>
          {state.reason === "retry_pending" ? (
            <button
              type="button"
              className="payment-result-page__retry"
              onClick={() => {
                setState({ step: "offer" });
                onSettled();
              }}
            >
              {t("Check payment status")}
            </button>
          ) : null}
          {state.reason === "unknown" ? (
            <button
              type="button"
              className="payment-result-page__retry"
              disabled={!online}
              onClick={() => setState({ step: "offer" })}
            >
              {t("Try again")}
            </button>
          ) : null}
        </div>
      ) : null}
      {!online ? <p role="alert">{t("Reconnect to pay with another card.")}</p> : null}
    </section>
  );
}
