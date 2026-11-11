import { t } from "./i18n/i18n.js";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { createOrdinaryRefundClient, OrdinaryRefundClientError } from "./ordinary-refund-client.js";
import { FULL_SIGN_IN_REQUIRED_TEXT, needsFullSignIn } from "./full-sign-in.js";

/**
 * WP-2423 C2: the payments link on an order lives apart from the refund page, so the Orders screen
 * does not carry the whole refund workflow in the first download.
 */
const client = createOrdinaryRefundClient();

const DENIED_TEXT = t(
  "Payments and refunds for this order are handled by a manager. Ask a manager if the guest needs a refund.",
);

/** What staff are told when a payment or refund read or command fails. */
/** WP-2423 M10: why "Stop making it too" was not done as asked; nothing was recorded. */
const withdrawRefusalText = (code: string) =>
  code === "WithdrawNeedsApproval"
    ? t(
        "Nothing was recorded. This refund needs the owner's approval, so the kitchen isn't told now. Untick Stop making it too to ask for approval; for a dish the kitchen hasn't started, use Cancel items on the order.",
      )
    : code === "WithdrawHandedOver"
      ? t(
          "Nothing was recorded. Part of this order was already handed over, so its dishes can't be stopped. Untick Stop making it too: the guest keeps the food.",
        )
      : code === "WithdrawEverything"
        ? t(
            "Nothing was recorded. This would refund and stop every dish of the pickup, leaving nothing to collect. If the kitchen hasn't started, use Cancel order on the order; otherwise untick Stop making it too: the guest keeps the food.",
          )
        : code === "WithdrawNeedsSender"
          ? t(
              "Nothing was recorded. A manager sends this refund, so the kitchen isn't told now. Untick Stop making it too to record the request; for a dish the kitchen hasn't started, use Cancel items on the order, or ask a manager.",
            )
          : code === "WithdrawStockNotReleasable"
            ? t(
                "Nothing was recorded. This dish's stock can't be returned on its own, so it can't be stopped with the refund. Untick Stop making it too: the refund is recorded and the guest keeps the food. To take the dish off the order instead, use Cancel items.",
              )
            : t(
                "Nothing was recorded. The kitchen just started one of these dishes. Look again and choose.",
              );
export const refundErrorText = (error: unknown) =>
  needsFullSignIn(error)
    ? FULL_SIGN_IN_REQUIRED_TEXT
    : error instanceof OrdinaryRefundClientError && error.code === "Denied"
      ? DENIED_TEXT
      : error instanceof OrdinaryRefundClientError && error.code === "Changed"
        ? t("This order changed while it was loading. Refresh to see the latest.")
        : error instanceof OrdinaryRefundClientError && error.code === "OrderNotAccepted"
          ? // WP-2423 M10: refunding every dish before acceptance is a refusal of the order. Only a
            // manager or owner reaches this page, and Orders offers them "Refuse and refund".
            t(
              "This order hasn't been accepted. Use Refuse and refund on the order to refund it in full.",
            )
          : error instanceof OrdinaryRefundClientError && error.code.startsWith("Withdraw")
            ? withdrawRefusalText(error.code)
            : error instanceof OrdinaryRefundClientError && error.code === "Conflict"
              ? t("The payment or refund selection changed. Refresh before trying again.")
              : t("Unable to refresh this information. Try again.");

export function OrderPaymentLinks({
  orderReference,
  csrf,
  fetcher,
  paidAsTable = false,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  /** A table's own payment, shown with its refunds in the panel beside this one. */
  readonly paidAsTable?: boolean;
  /** WP-2423 P5: an injected transport (the local demo); the shared client otherwise. */
  readonly fetcher?: typeof fetch | undefined;
}) {
  const paymentClient = useMemo(
    () => (fetcher === undefined ? client : createOrdinaryRefundClient(fetcher)),
    [fetcher],
  );
  const [links, setLinks] = useState<readonly string[]>([]),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    // v15 751dd768 ②: a refusal is final for this sign-in, so the button gives way to who to ask.
    [denied, setDenied] = useState(false);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);
  const load = async () => {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const result = await paymentClient.items(orderReference, csrf, controller.signal);
      if (!controller.signal.aborted) {
        const ids = [
          ...new Set(
            result.items.flatMap((item) =>
              item.paymentIntentReference === null ? [] : [item.paymentIntentReference],
            ),
          ),
        ];
        setLinks(ids);
        if (!ids.length)
          setMessage(
            paidAsTable
              ? t("This table's payment and refunds are shown above.")
              : t("This order has no paid payment yet."),
          );
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(refundErrorText(error));
        setDenied(error instanceof OrdinaryRefundClientError && error.code === "Denied");
      }
    } finally {
      pending.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  return (
    <section className="order-payment-links" aria-label={t("Order payments")}>
      {denied ? null : (
        <button disabled={busy} onClick={() => void load()}>
          {t("Payments and refunds")}
        </button>
      )}
      <p role="status">{message}</p>
      {links.map((reference, index) => (
        <p key={reference}>
          <Link to={"/app/operations/payments/" + reference}>
            {t("Payment {value} · refunds and details", { value: index + 1 })}
          </Link>
        </p>
      ))}
    </section>
  );
}
