import { useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import type { CurrentOrderQueue, StaffCancellationReason } from "./current-order-queue-client.js";
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
  readonly onSettled: () => void;
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
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
        error = typeof body?.error === "string" ? body.error : null;
      }
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
      onSettled();
    }
  };
  const message: Partial<Record<State, string>> = {
    Done: t("Refunded in full. The guest is told, and the items go back to stock."),
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
      {state === "Done" ? <p role="status">{message.Done}</p> : null}
      <dialog ref={dialog} className="order-cancel-dialog">
        <h2>{t("Can't make order {orderNumber}", { orderNumber: order.orderNumber })}</h2>
        <p>{staffCancelRefundText(pickup, preview)}</p>
        <p>
          {t(
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
              {state === "Pending" ? t("Refunding…") : t("Refund")}
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
