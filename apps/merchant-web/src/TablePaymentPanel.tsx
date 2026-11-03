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
  /** The part of a split bill this payment is for (null: the whole table). */
  readonly partNumber: number | null;
  readonly method: "CardMachine" | "Cash" | "Online";
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
  /** WP-2423 DEC-TABLE-ONLINE-REFUND: money going back to the guest's card. */
  readonly onlineRefunds: readonly {
    readonly amountMinor: string;
    readonly reasonCode: CashRefundReason;
    readonly requestedAt: string;
    readonly state: "Sending" | "Refunded" | "Refused";
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
const onlineRefundLabel = (refund: TablePayment["onlineRefunds"][number]) => {
  const reason = reasonText(refund.reasonCode);
  return refund.state === "Refunded"
    ? t("Refunded to the card · {reason}", { reason })
    : refund.state === "Sending"
      ? t("Going back to the card · {reason}", { reason })
      : t("Card company refused · {reason}", { reason });
};

const parseOne = (value: unknown): TablePayment => {
  const fail = (): never => {
    throw new Error("TABLE_PAYMENT_INVALID");
  };
  const p = value as Record<string, unknown>;
  const amount = (v: unknown) => (typeof v === "string" && minor.test(v) ? v : fail());
  const reason = (v: unknown) =>
    reasons.includes(v as CashRefundReason) ? (v as CashRefundReason) : fail();
  if (
    (p.method !== "Cash" && p.method !== "CardMachine" && p.method !== "Online") ||
    typeof p.takenAt !== "string" ||
    !Array.isArray(p.cashRefunds)
  )
    return fail();
  const onlineRefunds = Array.isArray(p.onlineRefunds) ? p.onlineRefunds : [];
  return Object.freeze({
    partNumber: typeof p.partNumber === "number" ? p.partNumber : null,
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
          reasonCode: reason(r.reasonCode),
          refundedAt: typeof r.refundedAt === "string" ? r.refundedAt : fail(),
        }),
      ),
    ),
    onlineRefunds: Object.freeze(
      onlineRefunds.map((r: Record<string, unknown>) =>
        Object.freeze({
          amountMinor: amount(r.amountMinor),
          reasonCode: reason(r.reasonCode),
          requestedAt: typeof r.requestedAt === "string" ? r.requestedAt : fail(),
          state:
            r.state === "Sending" || r.state === "Refunded" || r.state === "Refused"
              ? r.state
              : fail(),
        }),
      ),
    ),
    refundableMinor: amount(p.refundableMinor),
  });
};

export function parseTablePayment(value: unknown): TablePayment | null {
  const raw = (value ?? {}) as { payment?: unknown };
  return raw.payment === null || raw.payment === undefined ? null : parseOne(raw.payment);
}

/** The whole table's payment, or one per paid part of a split bill. */
export function parseTablePayments(value: unknown): readonly TablePayment[] {
  const raw = (value ?? {}) as { parts?: unknown };
  const whole = parseTablePayment(value);
  return Object.freeze([
    ...(whole === null ? [] : [whole]),
    ...(Array.isArray(raw.parts) ? raw.parts.map(parseOne) : []),
  ]);
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
 * WP-2423 DEC-DINE-IN-PAY-LATER (OPS-ORDER-QUEUE): a table's payment on its Order — how it was paid,
 * the tip, the cash rounding, the total — and what went back. A manager gives cash back from a cash
 * payment, or (DEC-TABLE-ONLINE-REFUND) refunds a phone payment to the guest's card: PIN-confirmed,
 * amount and reason, recorded beside the payment. A split bill shows each paid part.
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
  const [payments, setPayments] = useState<readonly TablePayment[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    post(fetcher, "/merchant/orders/table-payment", csrf, { orderReference })
      .then(({ status, payload }) => {
        if (!live) return;
        setPayments(status === 200 ? parseTablePayments(payload) : []);
      })
      .catch(() => {
        if (live) setPayments([]);
      });
    return () => {
      live = false;
    };
  }, [fetcher, csrf, orderReference, reload]);

  // A refund on its way shows its result without staff having to reopen the order.
  const sending = payments.some((payment) =>
    payment.onlineRefunds.some((refund) => refund.state === "Sending"),
  );
  useEffect(() => {
    if (!sending) return;
    const timer = setInterval(() => setReload((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, [sending]);

  return (
    <>
      {payments.map((payment) => (
        <TablePaymentBlock
          key={payment.partNumber ?? "whole"}
          payment={payment}
          orderReference={orderReference}
          csrf={csrf}
          fetcher={fetcher}
          onChanged={(next) => setPayments(next)}
          onStale={() => setReload((value) => value + 1)}
        />
      ))}
    </>
  );
}

function TablePaymentBlock({
  payment,
  orderReference,
  csrf,
  fetcher,
  onChanged,
  onStale,
}: {
  readonly payment: TablePayment;
  readonly orderReference: string;
  readonly csrf: string;
  readonly fetcher: typeof fetch;
  readonly onChanged: (payments: readonly TablePayment[]) => void;
  readonly onStale: () => void;
}) {
  const [refunding, setRefunding] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<CashRefundReason | "">("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const operation = useRef<{ key: string; reference: string } | null>(null);
  const amountMinor = useMemo(() => dollarsToMinor(amount), [amount]);
  const online = payment.method === "Online";

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
        online
          ? "/merchant/orders/table-payment/online-refund"
          : "/merchant/orders/table-payment/cash-refund",
        csrf,
        {
          orderReference,
          operationReference: operation.current.reference,
          amountMinor: amountMinor.toString(),
          reasonCode: reason,
          ...(payment.partNumber === null ? {} : { partNumber: payment.partNumber }),
        },
      );
      if (status === 200) {
        operation.current = null;
        onChanged(parseTablePayments(payload));
        setRefunding(false);
        setAmount("");
        setReason("");
        return;
      }
      operation.current = null;
      setProblem(
        status === 401 || status === 403
          ? online
            ? t(
                "A manager refunds this payment. Ask an Owner or Store Manager to sign in with their PIN.",
              )
            : t(
                "A manager gives cash back. Ask an Owner or Store Manager to sign in with their PIN.",
              )
          : payload?.error === "too_much"
            ? online
              ? t("That is more than is left of this payment.")
              : t("That is more than is left of this cash payment.")
            : online
              ? t("The refund wasn't sent. Try again.")
              : t("The cash refund wasn't recorded. Try again."),
      );
      onStale();
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
  const canRefund = (payment.method === "Cash" || online) && refundable > 0n;
  const openLabel = online ? t("Refund to the card") : t("Give cash back");
  return (
    <section
      className="table-payment"
      aria-label={
        payment.partNumber === null
          ? t("Paid at the table")
          : t("Paid at the table · part {number}", { number: String(payment.partNumber) })
      }
    >
      <h3>
        {payment.partNumber === null
          ? t("Paid at the table")
          : t("Paid at the table · part {number}", { number: String(payment.partNumber) })}
      </h3>
      <dl className="table-checkout__totals">
        <div>
          <dt>{t("Paid by")}</dt>
          <dd>
            {payment.method === "Cash"
              ? t("Cash")
              : payment.method === "Online"
                ? t("Guest's phone")
                : t("Card machine")}
          </dd>
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
        {payment.onlineRefunds.map((refund, index) => (
          <div key={index}>
            <dt>{onlineRefundLabel(refund)}</dt>
            <dd>
              {refund.state === "Refused" ? cad(refund.amountMinor) : "−" + cad(refund.amountMinor)}
            </dd>
          </div>
        ))}
        {(payment.method === "Cash" || online) && refundable !== BigInt(payment.totalMinor) ? (
          <div>
            <dt>{t("Left to refund")}</dt>
            <dd>{cad(refundable)}</dd>
          </div>
        ) : null}
      </dl>
      {payment.recordedAfterOutage ? <p role="note">{t("Recorded after an outage.")}</p> : null}
      {payment.onlineRefunds.some((refund) => refund.state === "Sending") ? (
        <p role="status">
          {t(
            "On its way to the card company. We keep sending it until they answer; you don't need to press again.",
          )}
        </p>
      ) : null}
      {payment.onlineRefunds.some((refund) => refund.state === "Refunded") ? (
        <p role="note">{t("It can take a few days to show on the guest's card.")}</p>
      ) : null}
      {payment.onlineRefunds.some((refund) => refund.state === "Refused") ? (
        <p role="note">{t("A refused refund moved no money. You can refund it again.")}</p>
      ) : null}
      {payment.method === "CardMachine" ? (
        <p role="note">
          {t("A table paid on the card machine can't be refunded here yet. Ask the Owner.")}
        </p>
      ) : null}
      {canRefund ? (
        refunding ? (
          <div role="group" aria-label={openLabel} className="table-payment__refund">
            <label className="table-checkout__field">
              {online ? t("Amount to refund") : t("Amount to give back")}
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
                ? online
                  ? t("Sending…")
                  : t("Recording…")
                : amountMinor !== null && amountMinor > 0n
                  ? online
                    ? t("Refund {amount} to the card", { amount: cad(amountMinor) })
                    : t("Give back {amount} in cash", { amount: cad(amountMinor) })
                  : openLabel}
            </button>{" "}
            <button type="button" disabled={busy} onClick={() => setRefunding(false)}>
              {t("Cancel")}
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setRefunding(true)}>
            {openLabel}
          </button>
        )
      ) : null}
      {problem ? <p role="alert">{problem}</p> : null}
    </section>
  );
}
