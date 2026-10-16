import { useRef, useState } from "react";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import {
  FULL_SIGN_IN_REQUIRED,
  FULL_SIGN_IN_REQUIRED_TEXT,
  isFullSignInRequired,
} from "./full-sign-in.js";
import { serviceOperationReference } from "./service-control-client.js";

type Outcome =
  | "Idle"
  | "Pending"
  | "Cancelled"
  | "Paid"
  | "PaymentInProgress"
  | "NotCancellable"
  | "Denied"
  | typeof FULL_SIGN_IN_REQUIRED
  | "Unknown";

/** The server's answer in staff words; only an unknown result keeps the same operation. */
export function unpaidRoundCancelOutcome(
  status: number,
  error: string | null,
): Exclude<Outcome, "Idle" | "Pending"> {
  if (status >= 200 && status < 300) return "Cancelled";
  if (isFullSignInRequired(status, { error })) return FULL_SIGN_IN_REQUIRED;
  if (status === 403) return "Denied";
  if (status === 409)
    return error === "unpaid_round_paid"
      ? "Paid"
      : error === "unpaid_round_payment_in_progress"
        ? "PaymentInProgress"
        : "NotCancellable";
  if (status === 400 || status === 404) return "NotCancellable";
  return "Unknown";
}

export const unpaidRoundCancelMessage: Record<Exclude<Outcome, "Idle">, string> = {
  Pending: "Cancelling…",
  Cancelled: "Round cancelled. It never went to the kitchen and nobody was charged.",
  Paid: "This round was paid after all, so it wasn't cancelled. Refresh to see it.",
  PaymentInProgress:
    "The guest's card payment is still being confirmed. Try again in a minute; nothing was cancelled.",
  NotCancellable: "This round can no longer be cancelled. Close to refresh it.",
  Denied: "Only a store manager or owner can cancel a round. Refresh if your session changed.",
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  Unknown: "Result unknown. Retry the same cancellation to recover its result.",
};
const keepsIntent = (outcome: Outcome) =>
  outcome === "Unknown" || outcome === FULL_SIGN_IN_REQUIRED;

/**
 * WP-2423 abandoned payment (DEC-DINING-ABANDONED-PAYMENT): a manager cancels a dine-in round
 * nobody paid for (for example the guest started paying on their phone and left), before the
 * system cancels it at its deadline. The server first ends the guest's unfinished card payment with
 * the card provider, refuses if the round was paid, and returns its items to stock. One intent
 * keeps its operation reference, so a lost answer is retried safely.
 */
export function UnpaidRoundCancelAction({
  orderReference,
  orderBatchReference,
  roundNumber,
  orderLabel,
  csrf,
  onSettled,
  fetcher = fetch,
}: {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly roundNumber: number;
  /** How staff recognise the order or table, e.g. "order 12" or "table DEMO-02". */
  readonly orderLabel: string;
  readonly csrf: string;
  readonly onSettled: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<string | null>(null);
  const refreshOnClose = useRef(false);
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const titleId = "unpaid-round-cancel-" + orderBatchReference;
  const submit = async () => {
    if (outcome === "Pending") return;
    operation.current ??= serviceOperationReference();
    setOutcome("Pending");
    let next: Exclude<Outcome, "Idle" | "Pending">;
    try {
      const response = await fetcher("/merchant/orders/cancel-unpaid-round", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          orderReference,
          orderBatchReference,
          operationReference: operation.current,
        }),
      });
      let error: string | null = null;
      if (!response.ok) {
        try {
          const body = (await response.json()) as unknown;
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string")
            error = body.error;
        } catch {
          error = null;
        }
      }
      next = unpaidRoundCancelOutcome(response.status, error);
    } catch {
      next = "Unknown";
    }
    if (!keepsIntent(next)) operation.current = null;
    setOutcome(next);
    if (next === "Cancelled") {
      dialog.current?.close();
      onSettled();
    } else if (!keepsIntent(next) && next !== "Denied") refreshOnClose.current = true;
  };
  const retrying = keepsIntent(outcome) && operation.current !== null;
  return (
    <div className="card-actions order-cancel-action">
      <button
        type="button"
        className="order-cancel-open"
        disabled={outcome === "Cancelled"}
        onClick={() => dialog.current?.showModal()}
      >
        Cancel unpaid round {roundNumber}
      </button>
      {outcome === "Cancelled" ? <p role="status">{unpaidRoundCancelMessage.Cancelled}</p> : null}
      <dialog
        ref={dialog}
        className="order-cancel-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (outcome === "Pending") event.preventDefault();
        }}
        onClose={() => {
          if (!refreshOnClose.current) return;
          refreshOnClose.current = false;
          onSettled();
        }}
      >
        <h2 id={titleId}>
          Cancel unpaid round {roundNumber} of {orderLabel}?
        </h2>
        <p>
          Nobody has paid for this round. Cancelling it means it never goes to the kitchen, its
          items go back to stock and the guest can&apos;t pay for it any more. Nobody is charged.
        </p>
        <p>If the guest is still paying on their phone, ask them first.</p>
        <div className="card-actions">
          <button
            type="button"
            data-variant="destructive"
            disabled={outcome === "Pending" || outcome === "Cancelled"}
            onClick={() => void submit()}
          >
            {retrying
              ? "Retry same cancellation"
              : outcome === "Pending"
                ? "Cancelling…"
                : `Cancel round ${roundNumber}`}
          </button>
          <button
            type="button"
            disabled={outcome === "Pending"}
            onClick={() => dialog.current?.close()}
          >
            Keep round
          </button>
        </div>
        {outcome === FULL_SIGN_IN_REQUIRED ? (
          <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
        ) : (
          <p role="status">{outcome === "Idle" ? null : unpaidRoundCancelMessage[outcome]}</p>
        )}
      </dialog>
    </div>
  );
}
