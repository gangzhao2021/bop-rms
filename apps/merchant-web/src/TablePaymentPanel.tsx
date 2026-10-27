import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { serviceOperationReference } from "./service-control-client.js";
import { dollarsToMinor } from "./TableCheckout.js";

const cad = (minor: string | bigint) =>
  orderMoney({ amountMinor: String(minor), currencyCode: "CAD" });
const minor = /^-?(?:0|[1-9][0-9]{0,18})$/u;

export type CashRefundReason = "FOOD_ISSUE" | "CUSTOMER_REQUEST" | "OVERCHARGED" | "STORE_ERROR";
export interface TablePayment {
  readonly method: "CardMachine" | "Cash";
  readonly roundsMinor: string;
  readonly tipMinor: string;
  readonly roundingMinor: string;
  readonly totalMinor: string;
  readonly takenAt: string;
  readonly recordedAfterOutage: boolean;
  readonly cashRefunds: readonly {
    readonly amountMinor: string;
    readonly reasonCode: CashRefundReason;
    readonly refundedAt: string;
  }[];
  readonly refundableMinor: string;
}
const reasons: readonly CashRefundReason[] = [
  "FOOD_ISSUE",
  "CUSTOMER_REQUEST",
  "OVERCHARGED",
  "STORE_ERROR",
];
const reasonText = (reason: CashRefundReason) =>
  ({
    FOOD_ISSUE: t("Problem with the food"),
    CUSTOMER_REQUEST: t("Guest asked"),
    OVERCHARGED: t("Charged too much"),
    STORE_ERROR: t("Store mistake"),
  })[reason];

export function parseTablePayment(value: unknown): TablePayment | null {
  const fail = (): never => {
    throw new Error("TABLE_PAYMENT_INVALID");
  };
  const raw = (value ?? {}) as { payment?: unknown };
  if (raw.payment === null) return null;
  const p = raw.payment as Record<string, unknown>;
  const amount = (v: unknown) => (typeof v === "string" && minor.test(v) ? v : fail());
  if (
    (p.method !== "Cash" && p.method !== "CardMachine") ||
    typeof p.takenAt !== "string" ||
    !Array.isArray(p.cashRefunds)
  )
    return fail();
  return Object.freeze({
    method: p.method,
    roundsMinor: amount(p.roundsMinor),
    tipMinor: amount(p.tipMinor),
    roundingMinor: amount(p.roundingMinor),
    totalMinor: amount(p.totalMinor),
    takenAt: p.takenAt,
    recordedAfterOutage: p.recordedAfterOutage === true,
    cashRefunds: Object.freeze(
      p.cashRefunds.map((r: Record<string, unknown>) =>
        Object.freeze({
          amountMinor: amount(r.amountMinor),
          reasonCode: reasons.includes(r.reasonCode as CashRefundReason)
            ? (r.reasonCode as CashRefundReason)
            : fail(),
          refundedAt: typeof r.refundedAt === "string" ? r.refundedAt : fail(),
        }),
      ),
    ),
    refundableMinor: amount(p.refundableMinor),
  });
}

async function post(fetcher: typeof fetch, path: string, csrf: string, body: unknown) {
  const response = await fetcher(path, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-BOP-CSRF": csrf },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return { status: response.status, payload };
}

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER (OPS-ORDER-QUEUE): a table's one payment on its Order — how it was
 * paid, the tip, the cash rounding, the total — and the cash given back. A manager gives cash back
 * from a cash payment (PIN-confirmed): amount and reason, recorded beside the payment.
 */
export function TablePaymentPanel({
  orderReference,
  csrf,
  fetcher = fetch,
}: {
  readonly orderReference: string;
  readonly csrf: string;
  readonly fetcher?: typeof fetch;
}) {
  const [payment, setPayment] = useState<TablePayment | null | undefined>(undefined);
  const [reload, setReload] = useState(0);
  const [refunding, setRefunding] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<CashRefundReason | "">("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const amountMinor = useMemo(() => dollarsToMinor(amount), [amount]);

  useEffect(() => {
    let live = true;
    post(fetcher, "/merchant/orders/table-payment", csrf, { orderReference })
      .then(({ status, payload }) => {
        if (!live) return;
        setPayment(status === 200 ? parseTablePayment(payload) : null);
      })
      .catch(() => {
        if (live) setPayment(null);
      });
    return () => {
      live = false;
    };
  }, [fetcher, csrf, orderReference, reload]);

  if (!payment) return null;
  const refundable = BigInt(payment.refundableMinor);
  const give = async () => {
    if (
      busy ||
      reason === "" ||
      amountMinor === null ||
      amountMinor <= 0n ||
      amountMinor > refundable
    )
      return;
    const key = amountMinor.toString() + ":" + reason;
    if (operation.current?.key !== key)
      operation.current = { key, reference: serviceOperationReference() };
    setBusy(true);
    setProblem(null);
    try {
      const { status, payload } = await post(
        fetcher,
        "/merchant/orders/table-payment/cash-refund",
        csrf,
        {
          orderReference,
          operationReference: operation.current.reference,
          amountMinor: amountMinor.toString(),
          reasonCode: reason,
        },
      );
      if (status === 200) {
        operation.current = null;
        setPayment(parseTablePayment(payload));
        setRefunding(false);
        setAmount("");
        setReason("");
        return;
      }
      operation.current = null;
      setProblem(
        status === 401 || status === 403
          ? t("A manager gives cash back. Ask an Owner or Store Manager to sign in with their PIN.")
          : payload?.error === "too_much"
            ? t("That is more than is left of this cash payment.")
            : t("The cash refund wasn't recorded. Try again."),
      );
      setReload((value) => value + 1);
    } catch {
      setProblem(
        t(
          "We couldn't confirm the result. Check the connection and press the button again: it is never recorded twice.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="table-payment" aria-label={t("Paid at the table")}>
      <h3>{t("Paid at the table")}</h3>
      <dl className="table-checkout__totals">
        <div>
          <dt>{t("Paid by")}</dt>
          <dd>{payment.method === "Cash" ? t("Cash") : t("Card machine")}</dd>
        </div>
        <div>
          <dt>{t("Rounds")}</dt>
          <dd>{cad(payment.roundsMinor)}</dd>
        </div>
        <div>
          <dt>{t("Tip")}</dt>
          <dd>{cad(payment.tipMinor)}</dd>
        </div>
        {payment.roundingMinor !== "0" ? (
          <div>
            <dt>{t("Cash rounding")}</dt>
            <dd>{cad(payment.roundingMinor)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t("Total paid")}</dt>
          <dd>{cad(payment.totalMinor)}</dd>
        </div>
        {payment.cashRefunds.map((refund, index) => (
          <div key={index}>
            <dt>{t("Cash given back · {reason}", { reason: reasonText(refund.reasonCode) })}</dt>
            <dd>−{cad(refund.amountMinor)}</dd>
          </div>
        ))}
      </dl>
      {payment.recordedAfterOutage ? <p role="note">{t("Recorded after an outage.")}</p> : null}
      {payment.method === "Cash" && refundable > 0n ? (
        refunding ? (
          <div role="group" aria-label={t("Give cash back")} className="table-payment__refund">
            <label className="table-checkout__field">
              {t("Amount to give back")}
              <input
                inputMode="decimal"
                value={amount}
                aria-invalid={amount !== "" && (amountMinor === null || amountMinor > refundable)}
                onChange={(event) => setAmount(event.currentTarget.value)}
              />
              <small>{t("Up to {amount}", { amount: cad(refundable) })}</small>
            </label>
            <label className="table-checkout__field">
              {t("Reason")}
              <select
                value={reason}
                onChange={(event) => setReason(event.currentTarget.value as CashRefundReason | "")}
              >
                <option value="">{t("Choose a reason")}</option>
                {reasons.map((code) => (
                  <option key={code} value={code}>
                    {reasonText(code)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="table-checkout__primary"
              disabled={
                busy ||
                reason === "" ||
                amountMinor === null ||
                amountMinor <= 0n ||
                amountMinor > refundable
              }
              onClick={() => void give()}
            >
              {busy
                ? t("Recording…")
                : amountMinor !== null && amountMinor > 0n
                  ? t("Give back {amount} in cash", { amount: cad(amountMinor) })
                  : t("Give cash back")}
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setRefunding(false)}>
              {t("Cancel")}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setRefunding(true)}>
            {t("Give cash back")}
          </button>
        )
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
