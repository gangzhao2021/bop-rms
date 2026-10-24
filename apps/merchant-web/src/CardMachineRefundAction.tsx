import { t } from "./i18n/i18n.js";
import { useRef, useState } from "react";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import {
  FULL_SIGN_IN_REQUIRED,
  FULL_SIGN_IN_REQUIRED_TEXT,
  isFullSignInRequired,
  type FullSignInRequired,
} from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];
type Outcome =
  | "Idle"
  | "Pending"
  | "Recorded"
  | "NothingOwed"
  | "Invalid"
  | "Denied"
  | FullSignInRequired
  | "Unknown";

/** The last part of the card machine's slip; never a card number (at most 12 digits). */
export function validSlipReference(value: string): boolean {
  return (
    value === "" ||
    (/^[A-Za-z0-9][A-Za-z0-9 #./-]{0,39}$/u.test(value) &&
      value.replace(/[^0-9]/gu, "").length <= 12)
  );
}

export function cardMachineRefundOutcome(
  status: number,
  error: string | null,
): Exclude<Outcome, "Idle" | "Pending"> {
  if (status >= 200 && status < 300) return "Recorded";
  if (isFullSignInRequired(status, { error })) return FULL_SIGN_IN_REQUIRED;
  if (status === 403) return "Denied";
  if (status === 409 && error === "nothing_to_refund") return "NothingOwed";
  if (status === 400) return "Invalid";
  if (status === 404 || status === 409) return "NothingOwed";
  return "Unknown";
}

const message: Record<Exclude<Outcome, "Idle">, string> = {
  Pending: "Recording…",
  Recorded: t("Recorded: refunded on the card machine."),
  NothingOwed: t("Nothing is left to refund on this order. Close to refresh it."),
  Invalid: t("Check the slip reference: letters and numbers only, never the card number."),
  Denied: t(
    "Only a store manager or owner can record this refund. Ask them to record it after refunding on the card machine.",
  ),
  FullSignInRequired: FULL_SIGN_IN_REQUIRED_TEXT,
  Unknown: t("Result unknown. Record it again; the same refund is never counted twice."),
};

/** The dialog's answer line; a PIN sign-in refusal shows how to confirm it is them instead. */
export function CardMachineRefundStatus({
  outcome,
  csrf,
  fetcher,
}: {
  readonly outcome: Outcome;
  readonly csrf: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  if (outcome === "Idle" || outcome === "Recorded") return null;
  if (outcome === FULL_SIGN_IN_REQUIRED) return <FullSignInPrompt csrf={csrf} fetcher={fetcher} />;
  return <p role={outcome === "Pending" ? "status" : "alert"}>{message[outcome]}</p>;
}

/**
 * WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD decision 4): a cancelled counter order was paid on the
 * Store's own card machine. Staff refund the amount on that machine, then record it here with the
 * slip reference. The amount is the server's (the whole remaining payment, tip included).
 */
export function CardMachineRefundAction({
  order,
  batch,
  csrf,
  onSettled,
  owedMinor = null,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly batch: Batch;
  readonly csrf: string;
  readonly onSettled: () => void;
  /** A paid order the store could not fulfil: what is still owed (the server decides). */
  readonly owedMinor?: string | null;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const operation = useRef<string | null>(null);
  const [slip, setSlip] = useState("");
  const [outcome, setOutcome] = useState<Outcome>("Idle");
  const cancellation = batch.staffCancellation;
  const amountMinor =
    cancellation !== null &&
    cancellation.refundMethod === "CardMachine" &&
    cancellation.refundStatus === "Pending"
      ? cancellation.refundAmountMinor
      : cancellation === null
        ? owedMinor
        : null;
  if (amountMinor === null) return null;
  const amount = orderMoney({ amountMinor, currencyCode: "CAD" });
  const titleId = "card-refund-" + batch.orderBatchReference;
  const submit = async () => {
    if (outcome === "Pending" || !validSlipReference(slip.trim())) return;
    operation.current ??= serviceOperationReference();
    setOutcome("Pending");
    let next: Exclude<Outcome, "Idle" | "Pending">;
    try {
      const response = await fetcher("/merchant/orders/card-machine-refund", {
        method: "POST",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify({
          operationReference: operation.current,
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          slipReference: slip.trim() === "" ? null : slip.trim(),
          refundedAt: null,
        }),
      });
      let error: string | null = null;
      if (!response.ok)
        try {
          const body = (await response.json()) as { error?: unknown };
          error = typeof body.error === "string" ? body.error : null;
        } catch {
          error = null;
        }
      next = cardMachineRefundOutcome(response.status, error);
    } catch {
      next = "Unknown";
    }
    // Unknown or a PIN sign-in to confirm first: a retry keeps the same operation.
    if (next !== "Unknown" && next !== FULL_SIGN_IN_REQUIRED) operation.current = null;
    setOutcome(next);
    if (next === "Recorded" || next === "NothingOwed") {
      dialog.current?.close();
      onSettled();
    }
  };
  return (
    <div className="card-actions card-machine-refund-action">
      <button type="button" onClick={() => dialog.current?.showModal()}>
        {t("Record card-machine refund")}
      </button>
      <dialog
        ref={dialog}
        className="order-cancel-dialog"
        aria-labelledby={titleId}
        onCancel={(event) => {
          if (outcome === "Pending") event.preventDefault();
        }}
      >
        <h2 id={titleId}>{t("Refund {amount} on the card machine", { amount: amount })}</h2>
        <p>
          {t(
            "Order {orderNumber} was paid on the store's card machine. Refund {amount} to the customer's card on the machine first, then record it here.",
            { orderNumber: order.orderNumber, amount: amount },
          )}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            {t("Slip reference (optional)")}
            <input
              value={slip}
              maxLength={40}
              autoComplete="off"
              inputMode="text"
              aria-describedby={titleId + "-hint"}
              aria-invalid={!validSlipReference(slip.trim())}
              onChange={(event) => setSlip(event.currentTarget.value)}
            />
          </label>
          <p id={titleId + "-hint"} className="field-hint">
            {t("The approval or reference code printed on the refund slip. Never the card number.")}
          </p>
          {outcome === FULL_SIGN_IN_REQUIRED ? null : (
            <CardMachineRefundStatus outcome={outcome} csrf={csrf} fetcher={fetcher} />
          )}
          <div className="card-actions">
            <button
              type="submit"
              disabled={outcome === "Pending" || !validSlipReference(slip.trim())}
            >
              {outcome === "Pending"
                ? t("Recording…")
                : t("Refunded {amount} on card machine", { amount: amount })}
            </button>
            <button
              type="button"
              disabled={outcome === "Pending"}
              onClick={() => dialog.current?.close()}
            >
              {t("Close")}
            </button>
          </div>
        </form>
        {/* Outside the form: the verification step has its own form. */}
        {outcome === FULL_SIGN_IN_REQUIRED ? (
          <CardMachineRefundStatus outcome={outcome} csrf={csrf} fetcher={fetcher} />
        ) : null}
      </dialog>
    </div>
  );
}
