import { useRef, useState } from "react";
import { Link } from "react-router";
import { t } from "./i18n/i18n.js";
import {
  type CurrentOrderLine,
  type CurrentOrderQueue,
  type StaffCancellationReason,
} from "./current-order-queue-client.js";
import { FullSignInPrompt } from "./FullSignInPrompt.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, isFullSignInRequired } from "./full-sign-in.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import {
  staffCancellationReasonLabel,
  staffCancellationReasonsFor,
} from "./StaffOrderCancelAction.js";

type Order = CurrentOrderQueue["items"][number];
type Batch = Order["batches"][number];
type Failure =
  | "FullSignInRequired"
  | "Denied"
  | "AlreadyPaid"
  | "Started"
  | "Changed"
  | "NotRemovable"
  | "Unknown";

export function payLaterRemoveFailureText(failure: Failure) {
  switch (failure) {
    case "FullSignInRequired":
      return FULL_SIGN_IN_REQUIRED_TEXT;
    case "Denied":
      return t("Taking dishes off the bill was refused. Ask a manager to do it.");
    case "AlreadyPaid":
      return t(
        "This table has paid, so dishes can't come off its bill. A manager gives the guest money back from the table's payment instead; it is recorded.",
      );
    case "Started":
      return t(
        "The kitchen has started one of these dishes, so it stays on the bill. To not charge the table for it, comp it with a reason instead; the comp is recorded.",
      );
    case "Changed":
      return t("This order changed since it was shown. Refresh it, then try again.");
    case "NotRemovable":
      return t(
        "These dishes were already made or served, so they stay on the bill. To not charge the table for them, comp them with a reason instead; the comp is recorded.",
      );
    case "Unknown":
      return t(
        "We couldn't confirm the result. Check the connection and press the button again: it is never recorded twice.",
      );
  }
}

const failureOf = (status: number, payload: unknown): Failure => {
  if (isFullSignInRequired(status, payload)) return "FullSignInRequired";
  if (status === 401 || status === 403) return "Denied";
  const error = (payload as { error?: unknown } | null)?.error;
  if (status === 409)
    return error === "already_paid"
      ? "AlreadyPaid"
      : error === "preparation_started"
        ? "Started"
        : error === "version_conflict"
          ? "Changed"
          : "NotRemovable";
  if (status === 400) return "NotRemovable";
  return "Unknown";
};

export interface PayLaterRemoveRefusal {
  readonly failure: "NotRemovable" | "Started" | "AlreadyPaid";
  readonly orderItemReferences: readonly string[];
}

/**
 * Coordinator 2026-10-30: why dishes couldn't come off the bill and what to do instead — comp them
 * with a reason (offered only for dishes the order lists as compable, which the server lists only to
 * people allowed to comp), or, on a paid table, a manager gives money back from its payment. Both
 * are recorded and attributed; nothing is deleted.
 */
export function PayLaterRemoveRefusalNotice({
  refusal,
  order,
  compInstead,
  compHref,
  refundHref,
  onDone,
}: {
  readonly refusal: PayLaterRemoveRefusal;
  readonly order: Order;
  /** Opens the recorded comp for these dishes on this page. */
  readonly compInstead?: ((orderItemReferences: readonly string[]) => void) | undefined;
  /** Where the comp is done when it isn't on this page (the table's page). */
  readonly compHref?: string | undefined;
  /** Where a manager gives money back from a paid table's payment (the order's page). */
  readonly refundHref?: string | undefined;
  readonly onDone: () => void;
}) {
  const compableNow = order.batches
    .flatMap((entry) => entry.compableItems)
    .filter((item) => refusal.orderItemReferences.includes(item));
  return (
    <div role="alert" className="pay-later-remove__instead">
      <p>{payLaterRemoveFailureText(refusal.failure)}</p>
      {refusal.failure === "AlreadyPaid" ? (
        refundHref !== undefined ? (
          <Link className="table-checkout__primary" to={refundHref}>
            {t("Give money back from the payment")}
          </Link>
        ) : null
      ) : compableNow.length > 0 && compInstead !== undefined ? (
        <button
          type="button"
          className="table-checkout__primary"
          onClick={() => {
            compInstead(compableNow);
            onDone();
          }}
        >
          {t("Comp these dishes")}
        </button>
      ) : compableNow.length > 0 && compHref !== undefined ? (
        <Link className="table-checkout__primary" to={compHref}>
          {t("Comp them on the table's page")}
        </Link>
      ) : (
        <p>{t("Ask a manager to comp them.")}</p>
      )}{" "}
      <button type="button" onClick={onDone}>
        {t("Close")}
      </button>
    </div>
  );
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (rule 2): take dishes — or the whole round — off the bill of a table
 * that pays at the end, before it pays and before the kitchen starts them. Staff tick the dishes
 * and give a reason; the server records who and why (PIN-confirmed) and the dishes are never
 * charged. One attempt keeps its operation reference, so a lost answer is retried safely.
 */
export function PayLaterItemRemoveAction({
  order,
  batch,
  lines,
  csrf,
  onSettled,
  onRefused,
  fetcher = fetch,
}: {
  readonly order: Order;
  readonly batch: Batch;
  /** The order's item lines (from its detail); only this round's removable dishes are offered. */
  readonly lines: readonly CurrentOrderLine[];
  readonly csrf: string;
  readonly onSettled: () => void;
  /** The dishes couldn't come off the bill (made, served or paid): the page shows what to do. */
  readonly onRefused: (refusal: PayLaterRemoveRefusal) => void;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reason, setReason] = useState<StaffCancellationReason | "">("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const attempt = useRef<{ key: string; reference: string } | null>(null);
  const offered = lines.filter(
    (line) =>
      line.orderBatchReference === batch.orderBatchReference &&
      batch.unpaidRemovableItems.includes(line.orderItemReference),
  );
  if (offered.length === 0 || order.currentVersion === null) return null;
  const chosen = offered.filter((line) => selected.has(line.orderItemReference));
  const amountMinor = chosen.reduce((sum, line) => sum + BigInt(line.total.amountMinor), 0n);
  const currencyCode = offered[0]?.total.currencyCode ?? "CAD";
  const send = async () => {
    if (busy || chosen.length === 0 || reason === "") return;
    const items = chosen.map((line) => line.orderItemReference).sort();
    const key = [items.join(","), reason, order.currentVersion].join(":");
    if (attempt.current?.key !== key)
      attempt.current = { key, reference: serviceOperationReference() };
    setBusy(true);
    setFailure(null);
    try {
      const response = await fetcher("/merchant/orders/remove-unpaid-items", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify({
          orderReference: order.orderReference,
          orderBatchReference: batch.orderBatchReference,
          orderItemReferences: items,
          expectedOrderVersion: order.currentVersion,
          operationReference: attempt.current.reference,
          reasonCode: reason,
        }),
      });
      const payload = (await response.json().catch(() => null)) as unknown;
      if (response.ok) {
        attempt.current = null;
        setOpen(false);
        setSelected(new Set());
        setReason("");
        onSettled();
        return;
      }
      const next = failureOf(response.status, payload);
      // A refusal that changed nothing keeps the attempt for the retry after signing in.
      if (next !== "FullSignInRequired" && next !== "Unknown") attempt.current = null;
      setFailure(next);
      // Made, served or paid: the page keeps the answer with what to do instead, even after the
      // refreshed order no longer offers these dishes here (never a silent failure).
      if (next === "NotRemovable" || next === "Started" || next === "AlreadyPaid")
        onRefused({ failure: next, orderItemReferences: items });
      // Read the order again: what changed (made, served, paid) decides what to offer instead.
      if (
        next === "AlreadyPaid" ||
        next === "Started" ||
        next === "Changed" ||
        next === "NotRemovable"
      )
        onSettled();
    } catch {
      setFailure("Unknown");
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {t("Take dishes off the bill")}
      </button>
    );
  return (
    <div
      role="group"
      aria-label={t("Take dishes off the bill")}
      className="pay-later-remove order-cancel-actions"
    >
      <p>{t("Tick the dishes the table won't be charged for. The kitchen stops them.")}</p>
      <ul className="pay-later-remove__lines">
        {offered.map((line) => (
          <li key={line.orderItemReference}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(line.orderItemReference)}
                disabled={busy}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.currentTarget.checked) next.add(line.orderItemReference);
                  else next.delete(line.orderItemReference);
                  setSelected(next);
                }}
              />{" "}
              {line.quantity} × {line.name} · {orderMoney(line.total)}
            </label>
          </li>
        ))}
      </ul>
      <label className="table-checkout__field">
        {t("Reason")}
        <select
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.currentTarget.value as StaffCancellationReason | "")}
        >
          <option value="">{t("Choose a reason")}</option>
          {staffCancellationReasonsFor("DineIn").map((code) => (
            <option key={code} value={code}>
              {staffCancellationReasonLabel[code]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="table-checkout__primary"
        disabled={busy || chosen.length === 0 || reason === ""}
        onClick={() => void send()}
      >
        {busy
          ? t("Recording…")
          : chosen.length === 0
            ? t("Take dishes off the bill")
            : chosen.length === offered.length
              ? t("Take the whole round off · {amount}", {
                  amount: orderMoney({ amountMinor: amountMinor.toString(), currencyCode }),
                })
              : t("Take off {amount}", {
                  amount: orderMoney({ amountMinor: amountMinor.toString(), currencyCode }),
                })}
      </button>{" "}
      <button type="button" disabled={busy} onClick={() => setOpen(false)}>
        {t("Cancel")}
      </button>
      {failure === "FullSignInRequired" ? (
        <FullSignInPrompt csrf={csrf} fetcher={fetcher} />
      ) : failure !== null &&
        failure !== "NotRemovable" &&
        failure !== "Started" &&
        failure !== "AlreadyPaid" ? (
        <p role="alert">{payLaterRemoveFailureText(failure)}</p>
      ) : null}
    </div>
  );
}
