import { useRef, useState } from "react";
import {
  staffCancellationReasons,
  type CurrentOrderQueue,
  type StaffCancellationReason,
} from "./current-order-queue-client.js";
import { serviceOperationReference } from "./service-control-client.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];

/** WP-2423 Q6: the reason labels staff choose from; the codes stay server-owned. */
export const staffCancellationReasonLabel: Readonly<Record<StaffCancellationReason, string>> = {
  CUSTOMER_REQUEST: "Customer request",
  SOLD_OUT: "Sold out",
  STORE_ERROR: "Store error",
  DUPLICATE_ORDER: "Duplicate order",
};

/** "Cancelled by store · refund pending" (pickup) or "Batch 2 cancelled · refunded" (dine-in). */
export function staffCancellationSummary(order: Order, batch: Batch) {
  if (batch.staffCancellation === null) return null;
  const machine = batch.staffCancellation.refundMethod === "CardMachine";
  return (
    (order.orderType === "Pickup" ? "Cancelled by store" : `Batch ${batch.sequence} cancelled`) +
    (batch.staffCancellation.refundStatus === "Refunded"
      ? machine
        ? " · refunded on card machine"
        : " · refunded"
      : machine
        ? " · refund on card machine"
        : " · refund pending")
  );
}

type Outcome =
  | "Idle"
  | "Pending"
  | "Cancelled"
  | "PreparationStarted"
  | "VersionConflict"
  | "NotCancellable"
  | "Denied"
  | "Unknown";

interface Intent {
  readonly operationReference: string;
  readonly reasonCode: StaffCancellationReason;
  readonly expectedOrderVersion: number;
}

/** The cancel command: intent only; staff identity, time, eligibility and refund are server-owned. */
export function staffCancelBody(order: Order, batch: Batch, intent: Intent) {
  if (!batch.canCancel || order.currentVersion === null)
    throw new Error("ORDER_CANCEL_UNAVAILABLE");
  return {
    orderReference: order.orderReference,
    orderBatchReference: batch.orderBatchReference,
    expectedOrderVersion: intent.expectedOrderVersion,
    operationReference: intent.operationReference,
    reasonCode: intent.reasonCode,
  };
}

/**
 * Cancelled (also an idempotent replay), kitchen already started, a stale order version, no longer
 * cancellable, denied, or unknown (retry the same operation to recover its result).
 */
export function staffCancelOutcome(
  status: number,
  error: string | null,
): Exclude<Outcome, "Idle" | "Pending"> {
  if (status >= 200 && status < 300) return "Cancelled";
  if (status === 403) return "Denied";
  if (status === 409)
    return error === "order_preparation_started"
      ? "PreparationStarted"
      : error === "order_version_conflict"
        ? "VersionConflict"
        : "NotCancellable";
  if (status === 400 || status === 404) return "NotCancellable";
  return "Unknown";
}

const message: Record<Exclude<Outcome, "Idle">, string> = {
  Pending: "Cancelling…",
  Cancelled: "Cancelled. The customer's refund has started.",
  PreparationStarted: "The kitchen has started — use a refund instead.",
  VersionConflict:
    "This order changed since it was shown. Close to refresh it, then cancel again if needed.",
  NotCancellable: "This order can no longer be cancelled. Close to refresh it.",
  Denied:
    "This cancellation was refused. Only a store manager or owner can cancel a paid order; refresh if your session changed.",
  Unknown: "Result unknown. Retry the same cancellation to recover its result.",
};

/**
 * WP-2423 Q6: cancel a paid pickup order, or one dine-in batch, before the kitchen starts. The
 * customer is refunded in full including tip. One intent keeps its operation reference so a lost
 * response is retried safely; any settled answer refreshes the order.
 */
export function StaffOrderCancelAction({
  order,
  batch,
  csrf,
  onSettled,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly batch: Batch;
  readonly csrf: string;
  /** Re-read the order after the server answered (cancelled, conflict or not cancellable). */
  readonly onSettled: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const intent = useRef<Intent | null>(null);
  const refreshOnClose = useRef(false);
  const [reason, setReason] = useState<StaffCancellationReason | "">("");
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const pickup = order.orderType === "Pickup";
  const label = pickup ? "Cancel order" : "Cancel batch";
  const titleId = "staff-cancel-" + batch.orderBatchReference;
  const submit = async () => {
    if (outcome === "Pending" || order.currentVersion === null) return;
    if (intent.current === null) {
      if (reason === "") return;
      intent.current = {
        operationReference: serviceOperationReference(),
        reasonCode: reason,
        expectedOrderVersion: order.currentVersion,
      };
    }
    setOutcome("Pending");
    let next: Exclude<Outcome, "Idle" | "Pending">;
    try {
      const response = await fetcher("/merchant/orders/cancel", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(staffCancelBody(order, batch, intent.current)),
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
      next = staffCancelOutcome(response.status, error);
    } catch {
      next = "Unknown";
    }
    // Only an unknown result keeps the same operation for a safe retry.
    if (next !== "Unknown") intent.current = null;
    setOutcome(next);
    // Cancelled re-reads at once; any other settled answer stays readable until the dialog closes.
    if (next === "Cancelled") {
      dialog.current?.close();
      onSettled();
    } else if (next !== "Unknown" && next !== "Denied") refreshOnClose.current = true;
  };
  const retrying = outcome === "Unknown" && intent.current !== null;
  return (
    <div className="card-actions order-cancel-action">
      <button
        type="button"
        className="order-cancel-open"
        disabled={outcome === "Cancelled"}
        onClick={() => dialog.current?.showModal()}
      >
        {label}
      </button>
      {outcome === "Cancelled" || outcome === "PreparationStarted" ? (
        <p role="status">{message[outcome]}</p>
      ) : null}
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
          {pickup
            ? `Cancel order ${order.orderNumber}`
            : `Cancel batch ${batch.sequence} of order ${order.orderNumber}`}
        </h2>
        <p>Only before the kitchen starts. The customer is refunded in full, including tip.</p>
        <p>
          {pickup
            ? "The order leaves the queue and its items return to stock."
            : "Only this batch is cancelled; the rest of the table's order continues."}
        </p>
        <form
          hidden={outcome !== "Idle" && outcome !== "Pending" && outcome !== "Unknown"}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            Reason
            <select
              required
              value={retrying ? (intent.current?.reasonCode ?? reason) : reason}
              disabled={retrying || outcome === "Pending"}
              onChange={(event) => setReason(event.currentTarget.value as StaffCancellationReason)}
            >
              <option value="">Select a reason</option>
              {staffCancellationReasons.map((code) => (
                <option key={code} value={code}>
                  {staffCancellationReasonLabel[code]}
                </option>
              ))}
            </select>
          </label>
          <div className="card-actions">
            <button
              type="submit"
              disabled={outcome === "Pending" || (!retrying && reason === "")}
              data-variant="destructive"
            >
              {retrying
                ? "Retry same cancellation"
                : outcome === "Pending"
                  ? "Cancelling…"
                  : pickup
                    ? "Cancel order and refund"
                    : "Cancel batch and refund"}
            </button>
            <button
              type="button"
              disabled={outcome === "Pending"}
              onClick={() => dialog.current?.close()}
            >
              Keep {pickup ? "order" : "batch"}
            </button>
          </div>
        </form>
        <p role="status">{outcome === "Idle" ? null : message[outcome]}</p>
        {outcome !== "Idle" && outcome !== "Pending" && outcome !== "Unknown" ? (
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        ) : null}
      </dialog>
    </div>
  );
}
