import { useCallback, useEffect, useState } from "react";
import { t, useReloadOnLanguageChange, nameLocale } from "../i18n/i18n.js";
import { formatMoney } from "../journey/format.js";
import { boundedJsonFetch } from "../network/bounded-fetch.js";
import { splitPartDishesText } from "./TablePayPanel.js";

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
  }[];
  readonly totalMinor: string;
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
    });
  });
  if (payments.length === 0) fail("none");
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
    totalMinor: minor(own.totalMinor),
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

/** "You paid $14.13 by card on this phone." — the one line every tab says to the payer. */
export const youPaidText = (amountMinor: string) =>
  t("You paid {amount} by card on this phone.", { amount: money(amountMinor) });

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

export function OwnPaymentReceiptView({ receipt }: { readonly receipt: OwnPaymentReceipt }) {
  return (
    <section
      className="order-status__card dining-session__receipt dining-session__own-payment"
      aria-labelledby="own-payment-receipt"
    >
      <h2 id="own-payment-receipt">{t("Your receipt")}</h2>
      <p>{youPaidText(receipt.totalMinor)}</p>
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
            <div>
              <dt>{t("Total paid by you")}</dt>
              <dd>{money(payment.totalMinor)}</dd>
            </div>
            <div>
              <dt>{t("Paid by")}</dt>
              <dd>{t("Card on this phone")}</dd>
            </div>
          </dl>
        </div>
      ))}
      {receipt.tablePaidInFull ? null : (
        <p>
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

/** Loads this phone's own payment's receipt; nothing is shown when it paid nothing here. */
export function OwnPaymentReceiptPanel({ client }: { readonly client: OwnPaymentReceiptClient }) {
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly receipt: OwnPaymentReceipt }
    | { readonly status: "none" }
    | { readonly status: "unavailable" }
  >({ status: "loading" });
  const load = useCallback(async () => {
    try {
      setState({ status: "ready", receipt: await client.read() });
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
  // Dish names follow the language the guest switches to (the server writes them).
  useReloadOnLanguageChange(() => void load());
  // A phone that paid nothing here sees nothing, not even a moment of "loading your receipt".
  if (state.status === "none" || state.status === "loading") return null;
  if (state.status === "unavailable")
    return (
      <section className="order-status__unavailable" role="alert">
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
  return <OwnPaymentReceiptView receipt={state.receipt} />;
}
