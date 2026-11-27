import { useState } from "react";
import { t } from "./i18n/i18n.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];
type State = "Idle" | "Pending" | "Done" | "Changed" | "Failed" | "Denied";

/** The server's answer to "Making it by hand", in what the screen does next. */
export function makingByHandOutcome(status: number): Exclude<State, "Idle" | "Pending"> {
  if (status >= 200 && status < 300) return "Done";
  if (status === 409) return "Changed";
  if (status === 401 || status === 403) return "Denied";
  return "Failed";
}

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: a pickup sent straight to the kitchen is refunded on its own
 * when the kitchen never marks it. When it is being made without the kitchen screen (the screen is
 * dead, or the ticket never arrived), whoever can accept says so here and the automatic refund
 * stops; a table round made from paper leaves the kitchen warnings the same way. No money moves; their name is recorded and the manager sees it tonight. Saying it twice is
 * harmless, so a retry needs no reference of its own.
 */
export function MakingByHandAction({
  order,
  batch,
  csrf,
  onSettled,
  failure = null,
  onFailed,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly batch: Batch;
  readonly csrf: string;
  /** Done carries the confirmation; the order card keeps showing it after the reread. */
  readonly onSettled: (done: string | null) => void;
  /**
   * WP-2423 live minor 12: why the last tap wasn't saved, kept by the page; the order's detail can
   * be read again (and this button made again) before staff have seen it.
   */
  readonly failure?: string | null;
  readonly onFailed?: ((failure: string | null) => void) | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [state, setState] = useState<State>("Idle");
  const message: Partial<Record<State, string>> = {
    Done:
      order.orderType === "Pickup"
        ? t(
            "Noted. It won't be refunded automatically. If you can't make it after all, tap Can't make it.",
          )
        : t(
            "Noted. It no longer shows as waiting for the kitchen. If you can't make it after all, tap Can't make it.",
          ),
    Changed: t("This order just changed. Check it again."),
    Failed: t("Not saved. Check the connection and try again."),
    Denied: t("You can't do this. Ask a manager."),
  };
  const submit = async () => {
    if (state === "Pending") return;
    setState("Pending");
    onFailed?.(null);
    let next: Exclude<State, "Idle" | "Pending">;
    try {
      const response = await fetcher("/merchant/orders/auto-accepted/keep", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
        }),
      });
      next = makingByHandOutcome(response.status);
    } catch {
      next = "Failed";
    }
    setState(next);
    if (next === "Failed" || next === "Denied") onFailed?.(message[next] ?? null);
    if (next === "Done" || next === "Changed")
      onSettled(next === "Done" ? (message.Done ?? null) : null);
  };
  return (
    <div className="card-actions order-keep-action">
      <button
        type="button"
        className="order-keep-open"
        disabled={state === "Pending" || state === "Done"}
        onClick={() => void submit()}
      >
        {state === "Pending" ? t("Saving…") : t("Making it by hand")}
      </button>
      {state === "Pending" || state === "Done" ? null : state === "Idle" ? (
        failure === null ? null : (
          <p role="alert">{failure}</p>
        )
      ) : (
        <p role="alert">{message[state]}</p>
      )}
    </div>
  );
}
