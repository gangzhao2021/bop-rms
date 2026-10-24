import { t } from "./i18n/i18n.js";
import { useRef, useState } from "react";
import { Link } from "react-router";
import {
  staffCancellationReasons,
  type CurrentOrderQueue,
  type StaffCancellationReason,
} from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import {
  FULL_SIGN_IN_REQUIRED,
  FULL_SIGN_IN_REQUIRED_TEXT,
  isFullSignInRequired,
} from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];

/** WP-2423 Q6: the reason labels staff choose from; the codes stay server-owned. */
export const staffCancellationReasonLabel: Readonly<Record<StaffCancellationReason, string>> = {
  CUSTOMER_REQUEST: t("Customer request"),
  SOLD_OUT: t("Sold out"),
  STORE_ERROR: t("Store error"),
  DUPLICATE_ORDER: t("Duplicate order"),
  GUEST_LEFT: t("Guests left"),
};

/**
 * WP-2423 (v15 2026-10-18): the reasons offered for an order type. "Guests left" is a table's
 * reason; the server refuses it on a pickup order.
 */
export function staffCancellationReasonsFor(orderType: Order["orderType"]) {
  return staffCancellationReasons.filter((code) => orderType !== "Pickup" || code !== "GUEST_LEFT");
}

/** WP-2423 (v15 2026-10-18): what the cancellation would refund, as the server reads it. */
export interface StaffCancelRefundPreview {
  readonly refundMethod: "Online" | "CardMachine";
  readonly paidMinor: string;
  readonly refundMinor: string;
}
const minor = /^(0|[1-9][0-9]{0,17})$/;
export function parseStaffCancelRefundPreview(
  value: unknown,
  order: Pick<Order, "orderReference">,
  batch: Pick<Batch, "orderBatchReference">,
): StaffCancelRefundPreview | null {
  if (value === null || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (
    raw.orderReference !== order.orderReference ||
    raw.orderBatchReference !== batch.orderBatchReference ||
    (raw.refundMethod !== "Online" && raw.refundMethod !== "CardMachine") ||
    typeof raw.paidMinor !== "string" ||
    !minor.test(raw.paidMinor) ||
    typeof raw.refundMinor !== "string" ||
    !minor.test(raw.refundMinor) ||
    raw.currencyCode !== "CAD" ||
    BigInt(raw.refundMinor) > BigInt(raw.paidMinor)
  )
    return null;
  return Object.freeze({
    refundMethod: raw.refundMethod,
    paidMinor: raw.paidMinor,
    refundMinor: raw.refundMinor,
  });
}

/**
 * WP-2423 (v15 2026-10-18): the dialog's refund line in staff words: refunded in full, the
 * remaining amount after earlier refunds, or nothing more when it was already refunded in full.
 * Without a preview (still checking, or it could not be read) it says what the server will do.
 */
export function staffCancelRefundText(
  pickup: boolean,
  preview: StaffCancelRefundPreview | "Checking" | "Failed",
): string {
  const what = pickup ? "order" : "round";
  if (preview === "Checking") return t("Checking what will be refunded…");
  if (preview === "Failed")
    return t(
      "What is refunded could not be checked. The customer gets back whatever is left of this {what}'s payment, including tip.",
      { what: what },
    );
  const money = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });
  const refund = BigInt(preview.refundMinor),
    paid = BigInt(preview.paidMinor);
  const machine = preview.refundMethod === "CardMachine";
  if (refund === 0n)
    return t("This {what} was already refunded in full; nothing more will be refunded.", {
      what: what,
    });
  if (refund >= paid)
    return machine
      ? t("Refund {refundMinor} in full, including tip, on the card machine.", {
          refundMinor: money(preview.refundMinor),
        })
      : t("The customer is refunded in full, {refundMinor} including tip.", {
          refundMinor: money(preview.refundMinor),
        });
  const already = money((paid - refund).toString());
  return machine
    ? t("{already} was already refunded. Refund the remaining {refundMinor} on the card machine.", {
        already: already,
        refundMinor: money(preview.refundMinor),
      })
    : t("{already} was already refunded. The customer is refunded the remaining {refundMinor}.", {
        already: already,
        refundMinor: money(preview.refundMinor),
      });
}

/** "Cancelled by store · refund pending" (pickup) or "Batch 2 cancelled · refunded" (dine-in). */
export function staffCancellationSummary(order: Order, batch: Batch) {
  if (batch.staffCancellation === null) return null;
  const machine = batch.staffCancellation.refundMethod === "CardMachine";
  return (
    (order.orderType === "Pickup"
      ? t("Cancelled by store")
      : t("Round {sequence} cancelled", { sequence: batch.sequence })) +
    (batch.staffCancellation.refundStatus === "Refunded"
      ? machine
        ? t(" · refunded on card machine")
        : t(" · refunded")
      : machine
        ? t(" · refund on card machine")
        : t(" · refund pending"))
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
  | typeof FULL_SIGN_IN_REQUIRED
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
 * cancellable, denied, refused until a PIN sign-in is confirmed (verify, then retry the same
 * operation), or unknown (retry the same operation to recover its result).
 */
export function staffCancelOutcome(
  status: number,
  error: string | null,
): Exclude<Outcome, "Idle" | "Pending"> {
  if (status >= 200 && status < 300) return "Cancelled";
  if (isFullSignInRequired(status, { error })) return FULL_SIGN_IN_REQUIRED;
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
  Cancelled: t("Cancelled. The customer's refund has started."),
  PreparationStarted: t("The kitchen has started — use a refund instead."),
  VersionConflict: t(
    "This order changed since it was shown. Close to refresh it, then cancel again if needed.",
  ),
  NotCancellable: t("This order can no longer be cancelled. Close to refresh it."),
  Denied: t(
    "This cancellation was refused. Only a store manager or owner can cancel a paid order; refresh if your session changed.",
  ),
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  Unknown: t("Result unknown. Retry the same cancellation to recover its result."),
};

/** Retry keeps the same operation: the result is unknown, or a PIN sign-in must be confirmed first. */
const keepsIntent = (outcome: Outcome) =>
  outcome === "Unknown" || outcome === FULL_SIGN_IN_REQUIRED;

/** The dialog's answer line; a PIN sign-in refusal shows how to confirm it is them instead. */
export function StaffCancelStatus({
  outcome,
  csrf,
  fetcher,
}: {
  readonly outcome: Outcome;
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  if (outcome === FULL_SIGN_IN_REQUIRED) return <FullSignInPrompt csrf={csrf} fetcher={fetcher} />;
  return <p role="status">{outcome === "Idle" ? null : message[outcome]}</p>;
}

/**
 * WP-2423 Q6: cancel a paid pickup order, or one dine-in batch, before the kitchen starts. The
 * customer gets back what is left of the payment, tip included; the dialog reads that amount from
 * the server when it opens (v15 2026-10-18: "nothing more" when already refunded). One intent keeps its operation reference so a lost
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
  const [preview, setPreview] = useState<StaffCancelRefundPreview | "Checking" | "Failed">(
    "Checking",
  );
  const pickup = order.orderType === "Pickup";
  const nothingToRefund = typeof preview === "object" && preview.refundMinor === "0";
  // WP-2423 (v15 2026-10-18): read what the cancellation would refund each time the dialog opens.
  const checkRefund = async () => {
    if (order.currentVersion === null) return;
    setPreview("Checking");
    try {
      const response = await fetcher("/merchant/orders/cancel/preview", {
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
  const label = pickup ? t("Cancel order") : t("Cancel round");
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
    // Only an unknown result, or a refusal until the PIN sign-in is confirmed, keeps the same
    // operation for a safe retry.
    if (!keepsIntent(next)) intent.current = null;
    setOutcome(next);
    // Cancelled re-reads at once; any other settled answer stays readable until the dialog closes.
    if (next === "Cancelled") {
      dialog.current?.close();
      onSettled();
    } else if (!keepsIntent(next) && next !== "Denied") refreshOnClose.current = true;
  };
  const retrying = keepsIntent(outcome) && intent.current !== null;
  const formOpen = outcome === "Idle" || outcome === "Pending" || keepsIntent(outcome);
  return (
    <div className="card-actions order-cancel-action">
      <button
        type="button"
        className="order-cancel-open"
        disabled={outcome === "Cancelled"}
        onClick={() => {
          dialog.current?.showModal();
          void checkRefund();
        }}
      >
        {label}
      </button>
      {outcome === "Cancelled" || outcome === "PreparationStarted" ? (
        <p role="status">
          {outcome === "Cancelled" && nothingToRefund
            ? t("Cancelled. It was already refunded in full; nothing more was refunded.")
            : message[outcome]}
        </p>
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
            ? t("Cancel order {orderNumber}", { orderNumber: order.orderNumber })
            : t("Cancel round {sequence} of order {orderNumber}", {
                sequence: batch.sequence,
                orderNumber: order.orderNumber,
              })}
        </h2>
        <p>{t("Only before the kitchen starts.")}</p>
        <p className="order-cancel-refund" aria-live="polite">
          {staffCancelRefundText(pickup, preview)}
          {preview === "Failed" ? (
            <>
              {" "}
              <button type="button" onClick={() => void checkRefund()}>
                {t("Check again")}
              </button>
            </>
          ) : null}
        </p>
        <p>
          {pickup
            ? t("The order leaves the queue and its items return to stock.")
            : t("Only this round is cancelled; the rest of the table's order continues.")}
        </p>
        {pickup ? (
          <p className="order-cancel-no-show">
            {t(
              "Customer not coming? If they told you, choose Customer request. If they just never came, keep the order: once it is ready and the one-hour pickup hold has passed, close it as not collected in",
            )}{" "}
            <Link to="/operations/pickup">{t("Pickup")}</Link>.
          </p>
        ) : null}
        <form
          hidden={!formOpen}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            {t("Reason")}
            <select
              required
              value={retrying ? (intent.current?.reasonCode ?? reason) : reason}
              disabled={retrying || outcome === "Pending"}
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
              disabled={outcome === "Pending" || (!retrying && reason === "")}
              data-variant="destructive"
            >
              {retrying
                ? t("Retry same cancellation")
                : outcome === "Pending"
                  ? t("Cancelling…")
                  : pickup
                    ? nothingToRefund
                      ? t("Cancel order")
                      : t("Cancel order and refund")
                    : nothingToRefund
                      ? t("Cancel round")
                      : t("Cancel round and refund")}
            </button>
            <button
              type="button"
              disabled={outcome === "Pending"}
              onClick={() => dialog.current?.close()}
            >
              {t("Keep {value}", { value: pickup ? t("order") : t("round") })}
            </button>
          </div>
        </form>
        <StaffCancelStatus outcome={outcome} csrf={csrf} fetcher={fetcher} />
        {!formOpen ? (
          <button type="button" onClick={() => dialog.current?.close()}>
            {t("Close")}
          </button>
        ) : null}
      </dialog>
    </div>
  );
}
