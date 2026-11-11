import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import { serviceOperationReference } from "./service-control-client.js";
import { browserOffline } from "./stale-read.js";
import { storeTime } from "./StoreTime.js";
import { orderMoney } from "./order-money.js";

type Order = CurrentOrderQueue["items"][number];

type State =
  | "Idle"
  | "Pending"
  | "Unknown"
  | "Recordable"
  | "Invalid"
  | "Used"
  | "Changed"
  | "Denied"
  | "Failed";

/** DEC-PAPER-ORDER-NEVER-RELEASED: the server's answer, as what the screen says next. */
export function paperReentryOutcome(status: number, error: unknown): Exclude<State, "Idle"> {
  if (status === 403 || status === 401) return "Denied";
  if (error === "paper_order_still_recordable") return "Recordable";
  if (error === "paper_reentry_invalid") return "Invalid";
  if (error === "paper_reentry_used") return "Used";
  if (status === 409 || status === 404) return "Changed";
  if (status >= 500 || status === 0) return "Unknown";
  return "Failed";
}

/**
 * DEC-PAPER-ORDER-NEVER-RELEASED: the paper orders that may stand for `order` once it was entered
 * again from its slip: paper counter orders sent after it whose payment is recorded and that were
 * not cancelled or closed, newest first.
 */
export function paperReentryCandidates(items: readonly Order[], order: Order): readonly Order[] {
  return [...items]
    .filter(
      (other) =>
        other.orderReference !== order.orderReference &&
        other.counter?.recordedAfterOutage === true &&
        other.counter.paidOnCardMachine !== null &&
        other.counter.cancelledBeforePayment === null &&
        other.currentPhase !== "Cancelled" &&
        other.currentPhase !== "Rejected" &&
        Date.parse(other.submittedAt) >= Date.parse(order.submittedAt),
    )
    .sort((a, b) => Date.parse(b.submittedAt) - Date.parse(a.submittedAt));
}

/**
 * DEC-PAPER-ORDER-NEVER-RELEASED: a paper order whose payment could not be recorded before its
 * time ended stays open (its sale is never released). Once staff entered it again from the paper
 * slip as a new paper order with its payment, a manager closes this one as entered again, naming
 * the new order; the sale then counts once, as the new order. A lost answer is sent again with the
 * same reference, so it never closes twice.
 */
export function PaperReentryAction({
  order,
  candidates,
  csrf,
  timeZone,
  fetcher = fetch,
  onClosed,
}: {
  readonly order: Order;
  readonly candidates: readonly Order[];
  readonly csrf: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
  readonly onClosed: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<string | null>(null);
  const [chosen, setChosen] = useState("");
  const [state, setState] = useState<State>("Idle");
  const batch = order.batches[0];
  const submit = async () => {
    if (chosen === "" || state === "Pending" || batch === undefined) return;
    if (browserOffline()) {
      setState("Unknown");
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
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          expectedOrderVersion: order.currentVersion,
          reasonCode: "COUNTER_PAPER_REENTERED",
          reenteredOrderReference: chosen,
        }),
      });
      if (response.ok) {
        dialog.current?.close();
        operation.current = null;
        setState("Idle");
        onClosed();
        return;
      }
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      next = paperReentryOutcome(response.status, body?.error);
    } catch {
      next = "Unknown";
    }
    if (next !== "Unknown") operation.current = null;
    setState(next);
  };
  const retrying = state === "Unknown" && operation.current !== null;
  const message: Partial<Record<State, string>> = {
    Pending: t("Linking…"),
    Unknown: t("No answer from the system. Try again: it is never closed twice."),
    Recordable: t("Its payment can still be recorded on it. Record it here instead."),
    Invalid: t(
      "That order isn't a paper order sent after this one with its payment recorded. Choose another.",
    ),
    Used: t("That new order already stands for another paper order. Choose another."),
    Changed: t("This order changed. The list will update."),
    Denied: t("Only a manager or the owner links it."),
    Failed: t("Not linked. Try again."),
  };
  const id = "paper-reentry-" + order.orderReference;
  return (
    <>
      <button type="button" onClick={() => dialog.current?.showModal()}>
        {t("Link the re-entered order")}
      </button>
      <dialog
        ref={dialog}
        className="order-cancel-dialog"
        aria-labelledby={id}
        onCancel={(event) => {
          if (state === "Pending") event.preventDefault();
        }}
      >
        <h2 id={id}>
          {t("Paper order {orderNumber} was entered again", { orderNumber: order.orderNumber })}
        </h2>
        <p>
          {t(
            "Choose the new paper order this one was entered again as. This order then closes as entered again, and its sale counts once, as the new order.",
          )}
        </p>
        {candidates.length === 0 ? (
          <>
            <p role="status">
              {t(
                "No new paper order with its payment recorded yet. Enter this one again from its paper slip as a paper order first, then link it here.",
              )}
            </p>
            <div className="card-actions">
              <button type="button" onClick={() => dialog.current?.close()}>
                {t("Close")}
              </button>
            </div>
          </>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {/* A lost answer is retried with the same reference and order: the first try may
                have closed it already. */}
            <fieldset disabled={state === "Pending" || retrying}>
              <legend>{t("New paper order")}</legend>
              {candidates.map((candidate) => (
                <label key={candidate.orderReference}>
                  <input
                    type="radio"
                    name={id + "-order"}
                    value={candidate.orderReference}
                    checked={chosen === candidate.orderReference}
                    onChange={() => setChosen(candidate.orderReference)}
                  />
                  {t("Order {orderNumber} · sent {sentAt} · {amount}", {
                    orderNumber: candidate.orderNumber,
                    sentAt: storeTime(candidate.submittedAt, timeZone),
                    amount: orderMoney({
                      amountMinor: candidate.counter?.paidOnCardMachine?.amountMinor ?? "0",
                      currencyCode: "CAD",
                    }),
                  })}
                </label>
              ))}
            </fieldset>
            {message[state] === undefined ? null : <p role="status">{message[state]}</p>}
            <div className="card-actions">
              <button type="submit" disabled={chosen === "" || state === "Pending"}>
                {t("Close as entered again")}
              </button>
              <button
                type="button"
                disabled={state === "Pending"}
                onClick={() => dialog.current?.close()}
              >
                {t("Keep it")}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </>
  );
}
