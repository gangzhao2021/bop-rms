import { useEffect, useMemo, useRef, useState } from "react";
import {
  staffCancellationReasons,
  type CurrentOrderLine,
  type CurrentOrderQueue,
  type StaffCancellationReason,
} from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED, FULL_SIGN_IN_REQUIRED_TEXT } from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import {
  createStaffItemCancellationClient,
  type ItemCancelFailure,
  type ItemCancelPreview,
  type ItemCancelScope,
} from "./staff-item-cancellation-client.js";
import { staffCancellationReasonLabel } from "./StaffOrderCancelAction.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];

/** "Cancelled · refund pending · $4.52" for one cancelled item line. */
export function itemCancellationStatus(
  cancellation: NonNullable<CurrentOrderLine["cancellation"]>,
) {
  return (
    (cancellation.refundStatus === "Refunded"
      ? "Cancelled · refunded · "
      : "Cancelled · refund pending · ") + orderMoney(cancellation.refund)
  );
}

/** What the server's preview means for the customer, in staff words. */
export function itemCancelPreviewText(order: Order, preview: ItemCancelPreview) {
  const refund = orderMoney(preview.refund);
  // DEC-TIP-REFUND-PROPORTIONAL: the items' share of the tip is refunded with them.
  if (preview.scope === "Items")
    return preview.refund.includesTip
      ? `Refund ${refund} (items, tax and ${orderMoney({
          amountMinor: preview.refund.tipAmountMinor,
          currencyCode: preview.refund.currencyCode,
        })} of the tip).`
      : `Refund ${refund} (items and tax).`;
  return order.orderType === "Pickup"
    ? `These are the last items: the whole order is cancelled and the remaining payment of ${refund} is refunded, including any tip.`
    : `These are the last items of this round: the whole round is cancelled and its remaining payment of ${refund} is refunded, including any tip.`;
}

/** Why a preview or cancellation did not go through, and what to do next. */
export function itemCancelFailureText(order: Order, failure: ItemCancelFailure) {
  switch (failure) {
    case "PreparationStarted":
      return "The kitchen has started one of these items. Close to refresh; use a refund for items already started.";
    case "VersionConflict":
      return "This order changed since it was shown. Close to refresh it, then try again if needed.";
    case "LegacyStock":
      return order.orderType === "Pickup"
        ? "This order's stock was reserved before per-item tracking, so its items cannot be cancelled one by one. Cancel the whole order instead."
        : "This round's stock was reserved before per-item tracking, so its items cannot be cancelled one by one. Cancel the whole round instead.";
    case "NotCancellable":
      return "These items can no longer be cancelled. Close to refresh the order.";
    case "Denied":
      return "This cancellation was refused. Only a store manager or owner can cancel paid items; refresh if your session changed.";
    case "FullSignInRequired":
      return FULL_SIGN_IN_REQUIRED_TEXT;
    case "Unknown":
      return "Result unknown. Retry the same cancellation to recover its result.";
  }
}

function cancelledText(order: Order, scope: ItemCancelScope) {
  return scope === "Items"
    ? "Items cancelled. The customer's refund has started."
    : order.orderType === "Pickup"
      ? "Order cancelled. The customer's refund has started."
      : "Round cancelled. The customer's refund has started.";
}

type PreviewState =
  | { readonly kind: "None" | "Loading" }
  | { readonly kind: "Ready"; readonly key: string; readonly value: ItemCancelPreview }
  | { readonly kind: "Failed"; readonly failure: ItemCancelFailure };
type Outcome = "Idle" | "Pending" | { readonly scope: ItemCancelScope } | ItemCancelFailure;

/** Failures after which the client keeps the same attempt for the retry. */
const keepsIntent = (outcome: Outcome) =>
  outcome === "Unknown" || outcome === FULL_SIGN_IN_REQUIRED;
/** Failures that leave the order as it was shown (nothing to re-read on close). */
const leavesOrder = (failure: ItemCancelFailure) =>
  failure === "Unknown" || failure === "Denied" || failure === FULL_SIGN_IN_REQUIRED;

/** The dialog's answer line; a PIN sign-in refusal shows how to confirm it is them instead. */
export function ItemCancelStatus({
  order,
  outcome,
  csrf,
  fetcher,
}: {
  readonly order: Order;
  readonly outcome: Outcome;
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  if (outcome === FULL_SIGN_IN_REQUIRED) return <FullSignInPrompt csrf={csrf} fetcher={fetcher} />;
  return (
    <p role="status">
      {outcome === "Pending"
        ? "Cancelling…"
        : typeof outcome === "string" && outcome !== "Idle"
          ? itemCancelFailureText(order, outcome)
          : null}
    </p>
  );
}

/**
 * WP-2423 Q6 step 2: cancel some items of a paid batch before the kitchen starts them. Staff pick
 * the items and a reason; the server previews the refund for the exact selection (the items' net,
 * tax and share of the tip, or — when they are the last items — the whole remaining payment
 * including any tip).
 * One attempt keeps its operation reference so a lost answer is retried safely; any settled answer
 * refreshes the order.
 */
export function StaffItemCancelAction({
  order,
  batch,
  lines,
  csrf,
  onSettled,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly batch: Batch;
  /** The order's item lines of this batch (cancelled lines are not offered again). */
  readonly lines: readonly CurrentOrderLine[];
  readonly csrf: string;
  /** Re-read the order after the server answered (cancelled, conflict or not cancellable). */
  readonly onSettled: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createStaffItemCancellationClient(csrf, fetcher), [csrf, fetcher]);
  const dialog = useRef<HTMLDialogElement>(null);
  const refreshOnClose = useRef(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState<StaffCancellationReason | "">("");
  const [preview, setPreview] = useState<PreviewState>({ kind: "None" });
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const pickup = order.orderType === "Pickup";
  const offered = lines.filter(
    (line) => line.orderBatchReference === batch.orderBatchReference && line.cancellation === null,
  );
  const key = [...selected].sort().join(",");
  const retrying = keepsIntent(outcome) && client.pendingIntent() !== null;
  const locked = retrying || outcome === "Pending";
  useEffect(() => {
    if (key === "" || order.currentVersion === null) {
      setPreview({ kind: "None" });
      return;
    }
    const controller = new AbortController();
    setPreview({ kind: "Loading" });
    client
      .preview(
        {
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          orderItemReferences: key.split(","),
          expectedOrderVersion: order.currentVersion,
        },
        controller.signal,
      )
      .then((answer) => {
        if (controller.signal.aborted) return;
        if (answer.ok) setPreview({ kind: "Ready", key, value: answer.value });
        else {
          setPreview({ kind: "Failed", failure: answer.failure });
          if (!leavesOrder(answer.failure)) refreshOnClose.current = true;
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [
    key,
    previewAttempt,
    client,
    order.orderReference,
    order.currentVersion,
    batch.orderBatchReference,
  ]);
  const ready = preview.kind === "Ready" && preview.key === key ? preview.value : null;
  const submit = async () => {
    if (outcome === "Pending" || order.currentVersion === null) return;
    const retry = client.pendingIntent();
    if (retry === null && (reason === "" || ready === null)) return;
    setOutcome("Pending");
    const answer = await client.cancel(
      {
        orderReference: order.orderReference,
        orderBatchReference: batch.orderBatchReference,
        orderItemReferences: [...selected],
        expectedOrderVersion: order.currentVersion,
      },
      retry?.reasonCode ?? (reason as StaffCancellationReason),
    );
    if (answer.ok) {
      setOutcome({ scope: answer.value.scope });
      dialog.current?.close();
      onSettled();
      return;
    }
    setOutcome(answer.failure);
    if (!leavesOrder(answer.failure)) refreshOnClose.current = true;
  };
  const settled = typeof outcome === "object";
  const formOpen = outcome === "Idle" || outcome === "Pending" || keepsIntent(outcome);
  const titleId = "staff-cancel-items-" + batch.orderBatchReference;
  const previewId = titleId + "-refund";
  const count = selected.size;
  return (
    <div className="card-actions order-cancel-action">
      <button
        type="button"
        className="order-cancel-open"
        disabled={settled}
        onClick={() => dialog.current?.showModal()}
      >
        Cancel items
      </button>
      {settled ? <p role="status">{cancelledText(order, outcome.scope)}</p> : null}
      <dialog
        ref={dialog}
        className="order-cancel-dialog order-item-cancel-dialog"
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
            ? `Cancel items from order ${order.orderNumber}`
            : `Cancel items from round ${batch.sequence} of order ${order.orderNumber}`}
        </h2>
        <p>
          Only items the kitchen has not started. The customer is refunded for the cancelled items,
          their tax and their share of any tip; the rest of the order continues.
        </p>
        <form
          hidden={!formOpen}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset className="order-item-cancel-items" disabled={locked}>
            <legend>Items to cancel</legend>
            {offered.map((line) => (
              <label key={line.orderItemReference} data-unavailable={!line.canCancel || undefined}>
                <input
                  type="checkbox"
                  checked={selected.has(line.orderItemReference)}
                  disabled={!line.canCancel}
                  aria-describedby={previewId}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(line.orderItemReference);
                      else next.delete(line.orderItemReference);
                      return next;
                    });
                  }}
                />
                <span className="order-item-cancel-name">
                  {line.quantity} × {line.name}
                  {line.canCancel ? null : (
                    <span className="order-item-cancel-unavailable">Not available</span>
                  )}
                </span>
                <span className="order-line-amount">{orderMoney(line.subtotal)}</span>
              </label>
            ))}
          </fieldset>
          <label>
            Reason
            <select
              required
              value={retrying ? (client.pendingIntent()?.reasonCode ?? reason) : reason}
              disabled={locked}
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
          <p id={previewId} className="order-item-cancel-refund" aria-live="polite">
            {ready !== null
              ? itemCancelPreviewText(order, ready)
              : preview.kind === "Loading"
                ? "Checking the refund…"
                : preview.kind === "Failed"
                  ? preview.failure === "Unknown"
                    ? "The refund could not be checked."
                    : itemCancelFailureText(order, preview.failure)
                  : "Select the items to cancel."}
          </p>
          {preview.kind === "Failed" && preview.failure === "Unknown" && !locked ? (
            <button type="button" onClick={() => setPreviewAttempt((value) => value + 1)}>
              Check refund again
            </button>
          ) : null}
          <div className="card-actions">
            <button
              type="submit"
              disabled={outcome === "Pending" || (!retrying && (reason === "" || ready === null))}
              data-variant="destructive"
            >
              {retrying
                ? "Retry same cancellation"
                : outcome === "Pending"
                  ? "Cancelling…"
                  : ready?.scope === "Batch"
                    ? pickup
                      ? "Cancel order and refund"
                      : "Cancel round and refund"
                    : count > 1
                      ? `Cancel ${count} items and refund`
                      : "Cancel item and refund"}
            </button>
            <button
              type="button"
              disabled={outcome === "Pending"}
              onClick={() => dialog.current?.close()}
            >
              Keep items
            </button>
          </div>
        </form>
        <ItemCancelStatus order={order} outcome={outcome} csrf={csrf} fetcher={fetcher} />
        {!formOpen ? (
          <button type="button" onClick={() => dialog.current?.close()}>
            Close
          </button>
        ) : null}
      </dialog>
    </div>
  );
}

type RefundCheck =
  | "Idle"
  | "Checking"
  | "Pending"
  | "Refunded"
  | "Failed"
  | "Denied"
  | typeof FULL_SIGN_IN_REQUIRED
  | "Unavailable";
const refundCheckText: Record<
  Exclude<RefundCheck, "Idle" | typeof FULL_SIGN_IN_REQUIRED>,
  string
> = {
  Checking: "Checking the refund…",
  Pending:
    "The refund hasn't gone through yet. If the payment provider or the internet is down, press Check refund again once it is back: the refund is sent then, never twice.",
  Refunded: "Refunded.",
  Failed: "The refund did not go through. Check this order's payment in Payments.",
  Denied: "Only a store manager or owner can check this refund.",
  Unavailable: "The refund status could not be checked. Try again.",
};

/**
 * WP-2423 Q6 step 2: ask for the refund of a pending item cancellation (sends it if it was not
 * sent yet, otherwise queries the provider; never refunds twice). A completed refund re-reads the
 * order; any other answer stays readable here.
 */
export function ItemRefundCheck({
  orderReference,
  cancellationReference,
  csrf,
  onChecked,
  fetcher = fetch,
}: {
  readonly orderReference: string;
  readonly cancellationReference: string;
  readonly csrf: string;
  readonly onChecked: () => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createStaffItemCancellationClient(csrf, fetcher), [csrf, fetcher]);
  const [state, setState] = useState<RefundCheck>("Idle");
  const check = async () => {
    if (state === "Checking") return;
    setState("Checking");
    const answer = await client.checkRefund(orderReference, cancellationReference);
    if (!answer.ok) {
      setState(
        answer.failure === "Denied" || answer.failure === FULL_SIGN_IN_REQUIRED
          ? answer.failure
          : "Unavailable",
      );
      return;
    }
    setState(answer.value.status);
    if (answer.value.status === "Refunded") onChecked();
  };
  return (
    <span className="order-line-refund-check">
      <button type="button" disabled={state === "Checking"} onClick={() => void check()}>
        Check refund
      </button>
      {state === FULL_SIGN_IN_REQUIRED ? (
        <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
      ) : (
        <span role="status">{state === "Idle" ? null : refundCheckText[state]}</span>
      )}
    </span>
  );
}
