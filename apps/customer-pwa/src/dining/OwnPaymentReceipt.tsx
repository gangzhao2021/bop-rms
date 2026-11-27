import { Fragment, useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { t, useReloadOnLanguageChange, nameLocale } from "../i18n/i18n.js";
import { formatDateTime, formatMoney } from "../journey/format.js";
import { boundedJsonFetch } from "../network/bounded-fetch.js";
import {
  getCustomerCsrfCredential,
  getSettledTableReceiptCsrf,
  subscribeCustomerCsrfContext,
} from "../session/customer-transaction-context.js";
import { splitPartDishesText } from "./TablePayPanel.js";
import { yourReceiptAttribute, yourReceiptInTableAttribute } from "./your-receipt-link.js";

/**
 * Batch 56 (v15 b55 live, guest-closed-bill-menu-cart): a guest who paid part of a table's bill on
 * their phone (their own dish, or one of staff's equal parts) and whose table's staff then closed
 * the rest had no record of that payment anywhere: no "you paid", no method, no receipt, and once
 * the table closed nothing at all. This is that guest's own receipt, read from Payment's record of
 * this phone's payments only (never another guest's amounts), while the table is open and once it
 * closed. It says what it covers and never that the table paid in full.
 */
export interface OwnPaymentReceipt {
  readonly tableLabel: string | null;
  /** Staff closed the rest of the bill (not charged). */
  readonly restClosedByStaff: boolean;
  readonly tablePaidInFull: boolean;
  readonly payments: readonly {
    readonly covers: "WholeTable" | "Part" | "Dishes";
    readonly partNumber: number | null;
    /** Of how many parts staff split the bill (null: not said). */
    readonly partCount: number | null;
    readonly dishes: readonly {
      readonly displayName: string;
      readonly quantity: number;
      readonly shared: boolean;
    }[];
    readonly subtotalMinor: string | null;
    readonly taxMinor: string | null;
    readonly tipMinor: string;
    readonly totalMinor: string;
    /**
     * Batch 57 (WP-2423 Q36): each refund of this payment back to its card, as Payment recorded
     * it, oldest first; a refused one is listed and was not taken off.
     */
    readonly refunds: readonly OwnPaymentRefund[];
    /** Refunded or on its way back to the card. */
    readonly refundedMinor: string;
  }[];
  readonly totalMinor: string;
  /** Batch 57: of `totalMinor`, refunded or on its way back, and what this phone paid net. */
  readonly refundedMinor: string;
  readonly netMinor: string;
}
export interface OwnPaymentRefund {
  readonly amountMinor: string;
  /** Pending: on its way (the card issuer has not confirmed it yet); Failed: nothing went back. */
  readonly status: "Pending" | "Refunded" | "Failed";
  readonly requestedAt: string;
  readonly answeredAt: string | null;
}

export class OwnPaymentReceiptError extends Error {
  constructor(readonly code: "none" | "unavailable") {
    super("own payment receipt " + code);
    this.name = "OwnPaymentReceiptError";
  }
}
const fail = (code: "none" | "unavailable" = "unavailable"): never => {
  throw new OwnPaymentReceiptError(code);
};
const minor = (value: unknown) =>
  typeof value === "string" && /^(0|[1-9][0-9]{0,15})$/u.test(value) ? value : fail();
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const list = (value: unknown, maximum: number): readonly unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail();
const instant = (value: unknown) =>
  typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value))
    ? value
    : fail();
const count = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 1000
    ? (value as number)
    : fail();

export function parseOwnPaymentReceipt(payload: unknown): OwnPaymentReceipt {
  const own = record(record(payload).ownPayment);
  const payments = list(own.payments, 20).map((value) => {
    const payment = record(value);
    if (payment.method !== "Online") fail();
    return Object.freeze({
      covers:
        payment.covers === "WholeTable" || payment.covers === "Part" || payment.covers === "Dishes"
          ? payment.covers
          : fail(),
      partNumber: payment.partNumber === null ? null : count(payment.partNumber),
      partCount: payment.partCount === null ? null : count(payment.partCount),
      dishes: list(payment.dishes, 200).map((entry) => {
        const dish = record(entry);
        return Object.freeze({
          displayName:
            typeof dish.displayName === "string" &&
            dish.displayName.length > 0 &&
            dish.displayName.length <= 200
              ? dish.displayName
              : fail(),
          quantity: count(dish.quantity),
          shared: typeof dish.shared === "boolean" ? dish.shared : fail(),
        });
      }),
      subtotalMinor: payment.subtotalMinor === null ? null : minor(payment.subtotalMinor),
      taxMinor: payment.taxMinor === null ? null : minor(payment.taxMinor),
      tipMinor: minor(payment.tipMinor),
      totalMinor: minor(payment.totalMinor),
      // A server from before batch 57 sends no refunds: none are said (as before).
      refunds:
        payment.refunds === undefined
          ? []
          : list(payment.refunds, 100).map((value) => {
              const refund = record(value);
              return Object.freeze({
                amountMinor: minor(refund.amountMinor),
                status:
                  refund.status === "Pending" ||
                  refund.status === "Refunded" ||
                  refund.status === "Failed"
                    ? refund.status
                    : fail(),
                requestedAt: instant(refund.requestedAt),
                answeredAt: refund.answeredAt === null ? null : instant(refund.answeredAt),
              });
            }),
      refundedMinor: payment.refundedMinor === undefined ? "0" : minor(payment.refundedMinor),
    });
  });
  if (payments.length === 0) fail("none");
  const totalMinor = minor(own.totalMinor);
  const refundedMinor = own.refundedMinor === undefined ? "0" : minor(own.refundedMinor);
  // Never more back than was paid, and the net is what was paid less it.
  if (BigInt(refundedMinor) > BigInt(totalMinor)) fail();
  const netMinor = (BigInt(totalMinor) - BigInt(refundedMinor)).toString();
  if (own.netMinor !== undefined && minor(own.netMinor) !== netMinor) fail();
  return Object.freeze({
    tableLabel:
      own.tableLabel === null
        ? null
        : typeof own.tableLabel === "string" && /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(own.tableLabel)
          ? own.tableLabel
          : fail(),
    restClosedByStaff: typeof own.restClosedByStaff === "boolean" ? own.restClosedByStaff : fail(),
    tablePaidInFull: typeof own.tablePaidInFull === "boolean" ? own.tablePaidInFull : fail(),
    payments,
    totalMinor,
    refundedMinor,
    netMinor,
  });
}

export interface OwnPaymentReceiptClient {
  read(): Promise<OwnPaymentReceipt>;
}

/**
 * Reads this phone's own payment with the value `csrf` gives: the table visit's while the guest is
 * at the table, the ended visit's read-only one once the table closed.
 */
export function createOwnPaymentReceiptClient(
  csrf: () => string | null,
  request: typeof fetch = globalThis.fetch,
): OwnPaymentReceiptClient {
  return Object.freeze({
    async read() {
      const value = csrf();
      if (value === null) return fail("none");
      let answer: Awaited<ReturnType<typeof boundedJsonFetch>>;
      try {
        answer = await boundedJsonFetch(request, "/api/v1/dine-in/table-payment", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": value,
          },
          body: JSON.stringify({
            action: "OwnPayment",
            ...(nameLocale() === null ? {} : { locale: nameLocale() }),
          }),
        });
      } catch {
        return fail();
      }
      // Not found: this phone paid nothing on the bill (or an older server).
      if (answer.response.status === 404 || answer.response.status === 400) return fail("none");
      if (answer.response.status !== 200 || answer.payload === null) return fail();
      return parseOwnPaymentReceipt(answer.payload);
    },
  });
}

const money = (amountMinor: string) => formatMoney(amountMinor, "CAD");

/**
 * Batch 56 review: while the table is still open after staff closed the rest, Menu, dish pages and
 * Cart say what this phone paid too, as Your table's receipt does (the payer otherwise read two
 * different things depending on whether staff had finished the table yet). One read per table
 * visit, kept in memory for this visit's credential: a payment on a closed bill no longer changes,
 * so moving between tabs asks nothing again. Another guest's phone is answered "nothing here".
 */
export interface OwnPaid {
  readonly paidMinor: string;
  /** Batch 57: of it, refunded or on its way back to the card ("0": none). */
  readonly refundedMinor: string;
  /** Batch 60: of that, still on its way (the card issuer has not confirmed it; "0": none). */
  readonly refundPendingMinor: string;
}

/** Batch 60: what of these refunds is still on its way to the card (minor units). */
export const pendingOf = (refunds: readonly OwnPaymentRefund[]): string =>
  refunds
    .filter((refund) => refund.status === "Pending")
    .reduce((sum, refund) => sum + BigInt(refund.amountMinor), 0n)
    .toString();
const ownPaidOf = (receipt: OwnPaymentReceipt): OwnPaid => ({
  paidMinor: receipt.totalMinor,
  refundedMinor: receipt.refundedMinor,
  refundPendingMinor: pendingOf(receipt.payments.flatMap((payment) => payment.refunds)),
});
let ownPaidAtTable: {
  readonly credential: string;
  readonly status: "loading" | "ready" | "none" | "unavailable";
  readonly paid: OwnPaid | null;
} | null = null;
const ownPaidListeners = new Set<() => void>();
function setOwnPaidAtTable(next: typeof ownPaidAtTable) {
  ownPaidAtTable = next;
  for (const listener of ownPaidListeners) listener();
}
const subscribeOwnPaid = (listener: () => void) => {
  ownPaidListeners.add(listener);
  return () => {
    ownPaidListeners.delete(listener);
  };
};
const getOwnPaid = () => ownPaidAtTable;

/** Tests start each case with nothing read. */
export function resetOwnPaidAtTable(): void {
  setOwnPaidAtTable(null);
}

/**
 * Batch 57: Your table's receipt read this phone's payment afresh (a refund staff made since shows
 * there): the other tabs say the same from then on.
 */
function keepOwnPaid(credential: string | null, receipt: OwnPaymentReceipt) {
  if (credential === null) return;
  setOwnPaidAtTable({ credential, status: "ready", paid: ownPaidOf(receipt) });
}

/**
 * What this phone paid on its table's bill (minor units) and how much of it went back, read only
 * while `enabled` (staff closed a bill some of which was paid); null while unread, when it paid
 * nothing, or when the read failed (Your table's receipt then offers to try again).
 */
export function useOwnPaidAtTable(enabled: boolean): OwnPaid | null {
  const credential = useSyncExternalStore(
    subscribeCustomerCsrfContext,
    getCustomerCsrfCredential,
    getCustomerCsrfCredential,
  );
  const known = useSyncExternalStore(subscribeOwnPaid, getOwnPaid, getOwnPaid);
  useEffect(() => {
    if (!enabled || credential === null) return;
    const kept = getOwnPaid();
    if (kept?.credential === credential && kept.status !== "unavailable") return;
    setOwnPaidAtTable({ credential, status: "loading", paid: null });
    const settle = (status: "ready" | "none" | "unavailable", paid: OwnPaid | null) => {
      if (getOwnPaid()?.credential === credential) setOwnPaidAtTable({ credential, status, paid });
    };
    createOwnPaymentReceiptClient(() => credential)
      .read()
      .then(
        (receipt) => settle("ready", ownPaidOf(receipt)),
        (error: unknown) =>
          settle(
            error instanceof OwnPaymentReceiptError && error.code === "none"
              ? "none"
              : "unavailable",
            null,
          ),
      );
  }, [enabled, credential]);
  return enabled && known?.credential === credential && known.status === "ready"
    ? known.paid
    : null;
}

/**
 * "You paid $14.13 online on this phone." — the one line every tab says to the payer. Batch 57
 * (Q36): with what went back to the card (refunded or on its way), and what they paid net. Batch
 * 60 (v15 b59 live, L59W A): what Payment confirmed is said as done (went back, 已退回), and only
 * what is still on its way as on its way; never "goes back" beside a refund dated as done.
 */
export const youPaidText = (amountMinor: string, refundedMinor = "0", refundPendingMinor = "0") => {
  const refunded = BigInt(refundedMinor);
  const pending = BigInt(refundPendingMinor) > refunded ? refunded : BigInt(refundPendingMinor);
  const done = refunded - pending;
  const amount = money(amountMinor);
  if (refunded <= 0n) return t("You paid {amount} online on this phone.", { amount });
  const net = money(
    (BigInt(amountMinor) - refunded > 0n ? BigInt(amountMinor) - refunded : 0n).toString(),
  );
  if (done > 0n && pending > 0n)
    return t(
      "You paid {amount} online on this phone. {done} went back to your card and {pending} is on its way, so in the end you pay {net}.",
      { amount, done: money(done.toString()), pending: money(pending.toString()), net },
    );
  if (refunded >= BigInt(amountMinor))
    return pending > 0n
      ? t("You paid {amount} online on this phone. All of it is on its way back to your card.", {
          amount,
        })
      : t("You paid {amount} online on this phone. All of it went back to your card.", { amount });
  return pending > 0n
    ? t(
        "You paid {amount} online on this phone. {refund} is on its way back to your card, so in the end you pay {net}.",
        { amount, refund: money(refundedMinor), net },
      )
    : t(
        "You paid {amount} online on this phone. {refund} went back to your card, so you paid {net}.",
        { amount, refund: money(refundedMinor), net },
      );
};

/** One refund of this phone's payment, in plain words: where the money is and what to do. */
export function refundText(refund: OwnPaymentRefund): string {
  const amount = money(refund.amountMinor);
  // The time is never last in a sentence ("12:21 p.m.." in English).
  if (refund.status === "Refunded")
    return t(
      "On {date}, {amount} went back to your card. Your bank may take a few days to show it.",
      {
        amount,
        date: formatDateTime(refund.answeredAt ?? refund.requestedAt),
      },
    );
  if (refund.status === "Pending")
    return t(
      "{amount} is on its way back to your card (sent {date}). Your card issuer has not confirmed it yet.",
      { amount, date: formatDateTime(refund.requestedAt) },
    );
  return t(
    "A refund of {amount} sent on {date} did not go through, so nothing went back to your card. Please ask staff.",
    { amount, date: formatDateTime(refund.requestedAt) },
  );
}

/**
 * Batch 60 (v15 b59 live): a payment's refunds as receipt rows — confirmed ("Refunded to your
 * card", 已退回您的卡) and still on its way ("On its way back to your card", 正在退回您的卡) —
 * each only when there is some.
 */
function refundRows(
  payment: OwnPaymentReceipt["payments"][number],
): readonly (readonly [string, string])[] {
  const refunded = BigInt(payment.refundedMinor);
  const pending = BigInt(pendingOf(payment.refunds));
  const onItsWay = pending > refunded ? refunded : pending;
  return (
    [
      [t("Refunded to your card"), (refunded - onItsWay).toString()],
      [t("On its way back to your card"), onItsWay.toString()],
    ] as const
  ).filter(([, amountMinor]) => amountMinor !== "0");
}

function coversText(payment: OwnPaymentReceipt["payments"][number]): string {
  if (payment.covers === "WholeTable") return t("Your table’s whole bill");
  if (payment.covers === "Dishes") return t("The dishes you paid for");
  return payment.partCount === null
    ? t("Part {number} of your table’s bill", { number: String(payment.partNumber ?? 1) })
    : t("Part {number} of {count} of your table’s bill", {
        number: String(payment.partNumber ?? 1),
        count: String(payment.partCount),
      });
}

/** Each of this phone's payments: what it covered, its amounts, how, and what went back. */
function OwnPaymentLines({ receipt }: { readonly receipt: OwnPaymentReceipt }) {
  return (
    <>
      {receipt.payments.map((payment, index) => (
        <div key={index}>
          <h3>{coversText(payment)}</h3>
          {payment.dishes.length === 0 ? null : <p>{splitPartDishesText(payment.dishes, true)}</p>}
          <dl className="order-status__money">
            {payment.subtotalMinor === null ? null : (
              <div>
                <dt>{t("Subtotal before tax")}</dt>
                <dd>{money(payment.subtotalMinor)}</dd>
              </div>
            )}
            {payment.taxMinor === null ? null : (
              <div>
                <dt>{t("Tax")}</dt>
                <dd>{money(payment.taxMinor)}</dd>
              </div>
            )}
            {payment.tipMinor === "0" ? null : (
              <div>
                <dt>{t("Tip")}</dt>
                <dd>{money(payment.tipMinor)}</dd>
              </div>
            )}
            {/* Batch 58 (v15 b57 live): once some of it went back, this row is what was charged
                and the net row is what was paid, so 实付 names one amount only. */}
            <div>
              <dt>
                {payment.refundedMinor === "0" ? t("Total paid by you") : t("Amount charged")}
              </dt>
              <dd>{money(payment.totalMinor)}</dd>
            </div>
            <div>
              <dt>{t("Paid by")}</dt>
              <dd>{t("Online by phone")}</dd>
            </div>
            {/* Batch 57 (Q36): what went back to the card, and what this payment came to net. */}
            {payment.refundedMinor === "0" ? null : (
              <>
                {/* Batch 60: what Payment confirmed went back, and what is still on its way. */}
                {refundRows(payment).map(([label, amountMinor]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>−{money(amountMinor)}</dd>
                  </div>
                ))}
                <div>
                  <dt>{t("You paid after refunds")}</dt>
                  <dd>
                    {money((BigInt(payment.totalMinor) - BigInt(payment.refundedMinor)).toString())}
                  </dd>
                </div>
              </>
            )}
          </dl>
          {payment.refunds.length === 0 ? null : (
            <ul className="dining-session__own-refunds" aria-label={t("Refunds of your payment")}>
              {payment.refunds.map((refund, number) => (
                <li key={number}>{refundText(refund)}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * Batch 63 (design review D62B-01, F02; Figma 51:223): right after this phone paid a part of the
 * bill or some dishes, with the table still open, Pay the bill says so first — "You paid $23.07
 * (tip $1.88) · Online by phone" beside a green dot — and then the same lines of each payment the
 * receipt gives, so the guest knows it went through before anything else is offered.
 */
export function youPaidSoFarText(receipt: OwnPaymentReceipt): string {
  const tipMinor = receipt.payments
    .reduce((sum, payment) => sum + BigInt(payment.tipMinor), 0n)
    .toString();
  return tipMinor === "0"
    ? t("You paid {amount} · Online by phone", { amount: money(receipt.totalMinor) })
    : t("You paid {amount} (tip {tip}) · Online by phone", {
        amount: money(receipt.totalMinor),
        tip: money(tipMinor),
      });
}

/**
 * Batch 65 (v15 b64 live, guest-split-own-payment): a phone that paid several parts of staff's
 * split, with the table still open, read each part's block ending in its own "Total paid by you",
 * as if there were two totals. As the ended receipt says it: one "Your payments" heading, each
 * part with how and how much (and what went back of it), and one total of what this phone paid.
 */
export const severalParts = (receipt: OwnPaymentReceipt) =>
  receipt.payments.length > 1 &&
  receipt.payments.every((payment) => payment.covers === "Part" && payment.partNumber !== null);

function OwnPartsPaid({ receipt }: { readonly receipt: OwnPaymentReceipt }) {
  return (
    <div className="dining-session__receipt-round" aria-labelledby="own-your-payments">
      <h3 id="own-your-payments">{t("Your payments")}</h3>
      <dl className="order-status__money">
        {receipt.payments.map((payment) => (
          <Fragment key={payment.partNumber}>
            <div>
              <dt>
                {t("Part {number} · {method}", {
                  number: String(payment.partNumber),
                  method: t("Online by phone"),
                })}
              </dt>
              <dd>{money(payment.totalMinor)}</dd>
            </div>
            {refundRows(payment).map(([label, amountMinor]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>−{money(amountMinor)}</dd>
              </div>
            ))}
            {payment.refundedMinor === "0" ? null : (
              <div>
                <dt>{t("You paid after refunds")}</dt>
                <dd>
                  {money((BigInt(payment.totalMinor) - BigInt(payment.refundedMinor)).toString())}
                </dd>
              </div>
            )}
          </Fragment>
        ))}
        <div className="dining-session__you-pay-total">
          <dt>{t("Total paid by you")}</dt>
          <dd>{money(receipt.totalMinor)}</dd>
        </div>
      </dl>
      {receipt.payments.some((payment) => payment.refunds.length > 0) ? (
        <ul className="dining-session__own-refunds" aria-label={t("Refunds of your payment")}>
          {receipt.payments
            .flatMap((payment) => payment.refunds)
            .map((refund, number) => (
              <li key={number}>{refundText(refund)}</li>
            ))}
        </ul>
      ) : null}
    </div>
  );
}

export function OwnPaidSoFarView({ receipt }: { readonly receipt: OwnPaymentReceipt }) {
  const refunds = receipt.payments.flatMap((payment) => payment.refunds);
  return (
    <div className="dining-session__you-paid" {...{ [yourReceiptAttribute]: "" }}>
      <p className="dining-session__you-paid-line" role="status">
        {receipt.refundedMinor === "0"
          ? youPaidSoFarText(receipt)
          : youPaidText(receipt.totalMinor, receipt.refundedMinor, pendingOf(refunds))}
      </p>
      {severalParts(receipt) ? (
        <OwnPartsPaid receipt={receipt} />
      ) : (
        <OwnPaymentLines receipt={receipt} />
      )}
    </div>
  );
}

export function OwnPaymentReceiptView({ receipt }: { readonly receipt: OwnPaymentReceipt }) {
  return (
    <section
      className="order-status__card dining-session__receipt dining-session__own-payment"
      aria-labelledby="own-payment-receipt"
      {...{ [yourReceiptAttribute]: "" }}
    >
      <h2 id="own-payment-receipt">{t("Your receipt")}</h2>
      <p>
        {youPaidText(
          receipt.totalMinor,
          receipt.refundedMinor,
          pendingOf(receipt.payments.flatMap((payment) => payment.refunds)),
        )}
      </p>
      <OwnPaymentLines receipt={receipt} />
      {receipt.tablePaidInFull ? null : (
        <p className="dining-session__own-payment-note">
          {receipt.restClosedByStaff
            ? t(
                "This receipt is for your payment only. Staff closed the rest of your table’s bill; it is not charged to you.",
              )
            : t("This receipt is for your payment only, not your table’s whole bill.")}
        </p>
      )}
    </section>
  );
}

/**
 * Batch 62 (v15 b61 live, G61 E): one phone paid the whole table and staff then gave some of it
 * back. The table's receipt already says what was paid, what went back and what the table paid
 * after it; inside it, the payer reads only what is theirs to know: that they paid it on this phone,
 * what went back to their card and when. Never a second receipt with the same three figures.
 */
export function OwnWholeTablePaymentLines({ receipt }: { readonly receipt: OwnPaymentReceipt }) {
  const refunds = receipt.payments.flatMap((payment) => payment.refunds);
  return (
    <div className="dining-session__own-payment-lines" {...{ [yourReceiptInTableAttribute]: "" }}>
      <p>{youPaidText(receipt.totalMinor, receipt.refundedMinor, pendingOf(refunds))}</p>
      {refunds.length === 0 ? null : (
        <ul className="dining-session__own-refunds" aria-label={t("Refunds of your payment")}>
          {refunds.map((refund, number) => (
            <li key={number}>{refundText(refund)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Loads this phone's own payment's receipt; nothing is shown when it paid nothing here. Batch 62:
 * `inTableReceipt`: said inside the table's receipt (a payment for the whole table is said as
 * lines of it). Batch 62 review: a phone that also paid a part or its dishes before the whole-table
 * settlement keeps its own receipt, apart from the table's: inside it shows nothing and `onApart`
 * asks the table page to show that receipt on its own.
 */
export function OwnPaymentReceiptPanel({
  client,
  inTableReceipt = false,
  soFar = false,
  onApart,
}: {
  readonly client: OwnPaymentReceiptClient;
  readonly inTableReceipt?: boolean;
  /** Batch 63: at the top of Pay the bill while the table is still open ("You paid …"). */
  readonly soFar?: boolean;
  readonly onApart?: (apart: boolean) => void;
}) {
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly receipt: OwnPaymentReceipt }
    | { readonly status: "none" }
    | { readonly status: "unavailable" }
  >({ status: "loading" });
  const load = useCallback(async () => {
    try {
      const receipt = await client.read();
      setState({ status: "ready", receipt });
      // Batch 57: a refund read here shows on Menu, dish pages and Cart from now on too.
      keepOwnPaid(getCustomerCsrfCredential(), receipt);
    } catch (error) {
      setState({
        status:
          error instanceof OwnPaymentReceiptError && error.code === "none" ? "none" : "unavailable",
      });
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const apart =
    inTableReceipt &&
    state.status === "ready" &&
    !state.receipt.payments.every((payment) => payment.covers === "WholeTable");
  useEffect(() => {
    if (inTableReceipt && state.status !== "loading") onApart?.(apart);
  }, [apart, inTableReceipt, onApart, state.status]);
  // Dish names follow the language the guest switches to (the server writes them).
  useReloadOnLanguageChange(() => void load());
  // A phone that paid nothing here sees nothing, not even a moment of "loading your receipt".
  if (state.status === "none" || state.status === "loading") return null;
  if (state.status === "unavailable")
    return (
      <section
        className="order-status__unavailable"
        role="alert"
        // Batch 62: "See your receipt" leads here when the receipt could not be read.
        {...{ [inTableReceipt ? yourReceiptInTableAttribute : yourReceiptAttribute]: "" }}
      >
        <p>{t("We couldn’t load your receipt. Check your connection and try again.")}</p>
        <button
          className="order-status__retry"
          type="button"
          onClick={() => {
            setState({ status: "loading" });
            void load();
          }}
        >
          {t("Try again")}
        </button>
      </section>
    );
  if (apart) return null;
  if (inTableReceipt) return <OwnWholeTablePaymentLines receipt={state.receipt} />;
  if (soFar) return <OwnPaidSoFarView receipt={state.receipt} />;
  return <OwnPaymentReceiptView receipt={state.receipt} />;
}

/**
 * Batch 64 (v15 b62 live, G62 A): once the table closed and was cleaned, the phone that paid the
 * whole bill read only the table's receipt — the same as every other phone — and lost "You paid
 * $28.25 online on this phone. $8.00 went back to your card …" and the refund's date it had read
 * while the table was open. Inside the settled receipt it reads them again, with the ended visit's
 * read-only value (the one its receipt is read with); a phone that paid nothing reads nothing.
 */
export function SettledOwnPaymentLines({
  client: provided,
}: {
  readonly client?: OwnPaymentReceiptClient | undefined;
}) {
  const [client] = useState(
    () => provided ?? createOwnPaymentReceiptClient(getSettledTableReceiptCsrf),
  );
  return <OwnPaymentReceiptPanel client={client} inTableReceipt />;
}
