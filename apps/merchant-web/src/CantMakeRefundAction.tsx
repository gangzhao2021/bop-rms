import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import type { CurrentOrderQueue, StaffCancellationReason } from "./current-order-queue-client.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  parseStaffCancelRefundPreview,
  staffCancellationReasonLabel,
  staffCancellationReasonsFor,
  staffCancelOutcome,
  staffCancelRefundText,
  type StaffCancelRefundPreview,
} from "./StaffOrderCancelAction.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];
type State = "Idle" | "Pending" | "Done" | "Started" | "Changed" | "Failed" | "Denied" | "Unknown";

/** What the server answered to Can't make it: what goes back, and whether it has gone yet. */
export interface CantMakeResult {
  readonly status: "Cancelled" | "AlreadyCancelled";
  readonly refundStatus: "Pending" | "Refunded";
  readonly refundMethod: "Online" | "CardMachine";
  /** What this cancellation gives back; null when the server could not say (a replay). */
  readonly refundAmountMinor: string | null;
}

/** The 200 answer, or null when it can't be read (then the dialog's preview is all there is). */
export function parseCantMakeResult(value: unknown): CantMakeResult | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const amount = raw.refundAmountMinor;
  if (
    (raw.status !== "Cancelled" && raw.status !== "AlreadyCancelled") ||
    (raw.refundStatus !== "Pending" && raw.refundStatus !== "Refunded") ||
    (raw.refundMethod !== "Online" && raw.refundMethod !== "CardMachine") ||
    (amount !== null && (typeof amount !== "string" || !/^(?:0|[1-9]\d{0,15})$/u.test(amount)))
  )
    return null;
  return Object.freeze({
    status: raw.status,
    refundStatus: raw.refundStatus,
    refundMethod: raw.refundMethod,
    refundAmountMinor: amount,
  });
}

/**
 * What staff read last, and repeat to the guest, from the server's answer: the amount that goes
 * back, "pending" until the Provider has confirmed it, never "in full" when part was given back
 * earlier, and plainly nothing when nothing was left. Only when the answer can't be read does it
 * fall back to the amount the dialog showed, and then it never says the money has gone.
 */
export function cantMakeDoneText(
  result: CantMakeResult | null,
  preview: StaffCancelRefundPreview | "Checking" | "Failed",
): string {
  const shown = typeof preview === "object" ? preview : null;
  const method = result?.refundMethod ?? shown?.refundMethod ?? "Online";
  // A first answer that is already "Refunded" means nothing was left to give back.
  const nothingLeft =
    result !== null
      ? result.status === "Cancelled" &&
        (result.refundAmountMinor === "0" || result.refundStatus === "Refunded")
      : shown?.refundMinor === "0";
  if (nothingLeft)
    return t(
      "Cancelled. It was already refunded in full, so nothing more was refunded. The guest is told.",
    );
  const amountMinor =
    result !== null && (result.refundAmountMinor !== null || method === "CardMachine")
      ? result.refundAmountMinor
      : (shown?.refundMinor ?? null);
  const amount = amountMinor === null ? null : orderMoney({ amountMinor, currencyCode: "CAD" });
  if (method === "CardMachine") {
    if (result?.refundStatus === "Refunded")
      return amount === null
        ? t("Cancelled. It was refunded on the card machine. The guest is told.")
        : t("Cancelled. {amount} was refunded on the card machine. The guest is told.", {
            amount,
          });
    return amount === null
      ? t("Cancelled. Refund what was left of the payment on the card machine. The guest is told.")
      : t("Cancelled. Refund {amount} on the card machine. The guest is told.", { amount });
  }
  if (amount === null)
    return result?.refundStatus === "Refunded"
      ? t(
          "Cancelled. What was left of the payment was refunded to the card they paid with. The guest is told, and the items go back to stock.",
        )
      : t(
          "Cancelled. Refund pending: what was left of the payment, to the card they paid with. The guest is told, and the items go back to stock.",
        );
  const partial =
    shown !== null && amountMinor !== null && BigInt(amountMinor) < BigInt(shown.paidMinor);
  if (result?.refundStatus === "Refunded")
    return partial
      ? t(
          "Cancelled. Refunded {amount}, what was left of the payment, to the card they paid with. The guest is told, and the items go back to stock.",
          { amount },
        )
      : t(
          "Cancelled. Refunded {amount} to the card they paid with. The guest is told, and the items go back to stock.",
          { amount },
        );
  return partial
    ? t(
        "Cancelled. Refund pending: {amount}, what was left of the payment, to the card they paid with. The guest is told, and the items go back to stock.",
        { amount },
      )
    : t(
        "Cancelled. Refund pending: {amount} to the card they paid with. The guest is told, and the items go back to stock.",
        { amount },
      );
}

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: whoever can accept may give back an automatically accepted
 * order the kitchen has not started. What is left of its payment, tip included, to the card that
 * paid, read when the dialog opens; a reason, one confirmation and their name on it. The manager
 * sees it on Home and in tonight's summary.
 */
export function CantMakeRefundAction({
  order,
  batch,
  csrf,
  onSettled,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly batch: Batch;
  readonly csrf: string;
  /** Done carries what to tell the guest; the order card keeps showing it after the reread. */
  readonly onSettled: (done: string) => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const intent = useRef<{
    operationReference: string;
    reasonCode: StaffCancellationReason;
    expectedOrderVersion: number;
  } | null>(null);
  const [reason, setReason] = useState<StaffCancellationReason | "">("");
  const [state, setState] = useState<State>("Idle");
  const [preview, setPreview] = useState<StaffCancelRefundPreview | "Checking" | "Failed">(
    "Checking",
  );
  const pickup = order.orderType === "Pickup";
  // Already given back in full: it can still be cancelled (the kitchen can't make it), refunding nothing.
  const nothingToRefund = typeof preview === "object" && preview.refundMinor === "0";
  // What it would give back, read each time the dialog opens (less if a dish was taken off since).
  const checkRefund = async () => {
    if (order.currentVersion === null) return;
    setPreview("Checking");
    try {
      const response = await fetcher("/merchant/orders/cant-make/preview", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          expectedOrderVersion: order.currentVersion,
        }),
      });
      const read = response.ok
        ? parseStaffCancelRefundPreview(await response.json(), order, batch)
        : null;
      setPreview(read ?? "Failed");
    } catch {
      setPreview("Failed");
    }
  };
  const submit = async () => {
    if (state === "Pending" || order.currentVersion === null) return;
    if (intent.current === null) {
      if (reason === "") return;
      intent.current = {
        operationReference: serviceOperationReference(),
        reasonCode: reason,
        expectedOrderVersion: order.currentVersion,
      };
    }
    setState("Pending");
    let next: State;
    let result: CantMakeResult | null = null;
    try {
      const response = await fetcher("/merchant/orders/cant-make", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          expectedOrderVersion: intent.current.expectedOrderVersion,
          operationReference: intent.current.operationReference,
          reasonCode: intent.current.reasonCode,
        }),
      });
      let error: string | null = null;
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) {
        const refusal = body as { error?: unknown } | null;
        error = typeof refusal?.error === "string" ? refusal.error : null;
      } else result = parseCantMakeResult(body);
      const outcome = staffCancelOutcome(response.status, error);
      next =
        outcome === "Cancelled"
          ? "Done"
          : outcome === "PreparationStarted"
            ? "Started"
            : outcome === "Denied" || outcome === "FullSignInRequired"
              ? "Denied"
              : outcome === "Unknown"
                ? "Unknown"
                : outcome === "VersionConflict" || outcome === "NotCancellable"
                  ? "Changed"
                  : "Failed";
    } catch {
      next = "Unknown";
    }
    // Only an unknown result keeps the same operation, for a safe retry.
    if (next !== "Unknown") intent.current = null;
    setState(next);
    if (next === "Done") {
      dialog.current?.close();
      onSettled(cantMakeDoneText(result, preview));
    }
  };
  const message: Partial<Record<State, string>> = {
    Started: t("The kitchen has started it, so it can't be undone here. Ask a manager."),
    Changed: t("This order just changed. Check it again."),
    Failed: t("Not done. Check the connection and try again."),
    Denied: t("You can't do this. Ask a manager."),
    Unknown: t("It isn't known whether this went through. Try again: it is only done once."),
  };
  return (
    <div className="card-actions order-cancel-action">
      <button
        type="button"
        className="order-cancel-open"
        disabled={state === "Done"}
        onClick={() => {
          dialog.current?.showModal();
          void checkRefund();
        }}
      >
        {t("Can't make it · refund")}
      </button>
      <dialog ref={dialog} className="order-cancel-dialog">
        <h2>{t("Can't make order {orderNumber}", { orderNumber: order.orderNumber })}</h2>
        <p>{staffCancelRefundText(pickup, preview)}</p>
        <p>
          {nothingToRefund
            ? t("They are told why. Your name is recorded.")
            : t(
                "The money goes back to the card they paid with, and they are told why. Your name is recorded.",
              )}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            {t("Reason")}
            <select
              required
              value={intent.current?.reasonCode ?? reason}
              disabled={state === "Pending" || intent.current !== null}
              onChange={(event) => setReason(event.currentTarget.value as StaffCancellationReason)}
            >
              <option value="">{t("Select a reason")}</option>
              {staffCancellationReasonsFor(order.orderType).map((code) => (
                <option key={code} value={code}>
                  {staffCancellationReasonLabel[code]}
                </option>
              ))}
            </select>
          </label>
          <div className="card-actions">
            <button
              type="submit"
              data-variant="destructive"
              disabled={state === "Pending" || (reason === "" && intent.current === null)}
            >
              {state === "Pending"
                ? nothingToRefund
                  ? t("Cancelling…")
                  : t("Refunding…")
                : nothingToRefund
                  ? t("Cancel without a refund")
                  : t("Refund")}
            </button>
            <button type="button" onClick={() => dialog.current?.close()}>
              {t("Keep the order")}
            </button>
          </div>
        </form>
        {state !== "Idle" && state !== "Pending" && state !== "Done" ? (
          <p role="alert">{message[state]}</p>
        ) : null}
      </dialog>
    </div>
  );
}
