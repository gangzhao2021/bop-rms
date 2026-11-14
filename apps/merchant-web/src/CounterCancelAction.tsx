import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import type { CounterCancelReason } from "./current-order-queue-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { browserOffline } from "./stale-read.js";

/** WP-2423 M127: why a counter order nobody paid for is cancelled, in the staff member's words. */
export function counterCancelReasonText(reason: CounterCancelReason): string {
  return reason === "COUNTER_GUEST_CHANGED_MIND"
    ? t("Guest changed their mind")
    : reason === "COUNTER_ENTERED_WRONG"
      ? t("Entered by mistake")
      : reason === "COUNTER_PAPER_REENTERED"
        ? // DEC-PAPER-ORDER-NEVER-RELEASED: its sale counts as the new paper order.
          t("Entered again from its paper slip")
        : t("Guest left without paying");
}

type State = "Idle" | "Pending" | "Unknown" | "Paid" | "Changed" | "Denied" | "Failed" | "Paper";

/** The server's refusal, as what the screen says next. */
export function counterCancelOutcome(status: number, error: unknown): Exclude<State, "Idle"> {
  if (status === 403 || status === 401) return "Denied";
  if (error === "counter_cancel_already_paid") return "Paid";
  if (error === "counter_cancel_paper_order") return "Paper";
  if (status === 409 || status === 404) return "Changed";
  if (status >= 500 || status === 0) return "Unknown";
  return "Failed";
}

/**
 * WP-2423 M127: "Cancel order" on an unpaid counter order (counter screen and Orders). Staff choose
 * why; the order is recorded as cancelled before payment with their name and the reason, and its
 * items go back to stock at once. A lost answer is sent again with the same reference, so it never
 * cancels twice. Offered only to those who may cancel orders.
 */
export function CounterCancelAction({
  orderReference,
  orderBatchReference,
  orderNumber,
  expectedOrderVersion,
  csrf,
  onCancelled,
  fetcher = fetch,
  defaultReason,
  label,
}: {
  /** The button's words ("Cancel order" unless given). */
  readonly label?: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly orderNumber: string;
  readonly expectedOrderVersion: number;
  readonly csrf: string;
  readonly onCancelled: () => void;
  readonly fetcher?: typeof fetch;
  /** "Back to edit": entered by mistake, chosen already. */
  readonly defaultReason?: CounterCancelReason;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<string | null>(null);
  const [reason, setReason] = useState<CounterCancelReason | "">(defaultReason ?? "");
  const [state, setState] = useState<State>("Idle");
  const submit = async () => {
    if (reason === "" || state === "Pending" || browserOffline()) {
      if (browserOffline()) setState("Unknown");
      return;
    }
    operation.current ??= serviceOperationReference();
    setState("Pending");
    let next: Exclude<State, "Idle">;
    try {
      const response = await fetcher("/merchant/counter/orders/cancel-unpaid", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          operationReference: operation.current,
          orderReference,
          orderBatchReference,
          expectedOrderVersion,
          reasonCode: reason,
        }),
      });
      if (response.ok) {
        dialog.current?.close();
        onCancelled();
        setState("Idle");
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      next = counterCancelOutcome(response.status, body?.error);
    } catch {
      next = "Unknown";
    }
    // Only a lost answer keeps the same reference for the next try.
    if (next !== "Unknown") operation.current = null;
    setState(next);
  };
  const retrying = state === "Unknown" && operation.current !== null;
  const message: Partial<Record<State, string>> = {
    Pending: t("Cancelling…"),
    Unknown: t(
      "Not confirmed yet. Check the connection, then tap Cancel order again; it is never cancelled twice.",
    ),
    Paid: t("This order was just paid. Cancel it from Orders instead (a refund is needed)."),
    Paper: t("A paper order was already paid during the outage. Record its payment instead."),
    Changed: t("This order just changed. Close this and check it again."),
    Denied: t("Only a manager can cancel an order. Ask a manager."),
    Failed: t("Not cancelled. Try again."),
  };
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        {label ?? t("Cancel order")}
      </button>
      <dialog
        ref={dialog}
        className="order-cancel-dialog"
        aria-labelledby={"counter-cancel-" + orderReference}
        onCancel={(event) => {
          if (state === "Pending") event.preventDefault();
        }}
      >
        <h2 id={"counter-cancel-" + orderReference}>
          {t("Cancel order {orderNumber}?", { orderNumber })}
        </h2>
        <p>
          {t(
            "Nothing was charged. The order is kept as cancelled before payment, with your name and the reason, and its items go back to stock.",
          )}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {/* A lost answer is retried with the same reference and reason: the first try may have
              cancelled it already, so the reason is kept as sent. */}
          <fieldset disabled={state === "Pending" || retrying}>
            <legend>{t("Why")}</legend>
            {(
              [
                "COUNTER_GUEST_CHANGED_MIND",
                "COUNTER_ENTERED_WRONG",
                "COUNTER_GUEST_LEFT_UNPAID",
              ] as const
            ).map((value) => (
              <label key={value}>
                <input
                  type="radio"
                  name={"counter-cancel-reason-" + orderReference}
                  value={value}
                  checked={reason === value}
                  onChange={() => setReason(value)}
                />
                {counterCancelReasonText(value)}
              </label>
            ))}
          </fieldset>
          {message[state] === undefined ? null : <p role="status">{message[state]}</p>}
          <div className="card-actions">
            <button
              type="submit"
              data-variant="danger"
              disabled={reason === "" || state === "Pending"}
            >
              {t("Cancel order {orderNumber}", { orderNumber })}
            </button>
            <button
              type="button"
              disabled={state === "Pending"}
              onClick={() => dialog.current?.close()}
            >
              {t("Keep the order")}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
