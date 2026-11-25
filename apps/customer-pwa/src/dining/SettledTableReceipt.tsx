import { useCallback, useEffect, useState } from "react";
import { t, saidTable, nameLocale, useReloadOnLanguageChange } from "../i18n/i18n.js";
import { formatDateTime, formatLocalityLine, formatMoney } from "../journey/format.js";
import { MemberJoinPanel } from "../member/MemberJoinPanel.js";
import { boundedJsonFetch } from "../network/bounded-fetch.js";
import { getSettledTableReceiptCsrf } from "../session/customer-transaction-context.js";

/**
 * Coordinator 2026-10-30 (Owner authorized): the receipt of a table that was closed after its bill
 * was settled, whatever paid it (cash, the card machine, a guest's phone, or the parts of a split
 * bill): the dishes, before tax, tax, tip, cash rounding, the total and how each payment was made.
 * Read with the ended visit's value (read only); never card details or who took the payment.
 */
type Method = "CardMachine" | "Cash" | "Online";
export interface SettledTableReceipt {
  readonly tableLabel: string | null;
  /**
   * Batch 63 (design review D62B-03, F05): who the receipt is from — the Store's published names
   * and address — and when the bill was paid. Null: an older server, or not readable now.
   */
  readonly merchant: null | {
    readonly brandDisplayName: string;
    readonly storeDisplayName: string;
    readonly address: {
      readonly addressLines: readonly string[];
      readonly locality: string;
      readonly regionCode: string;
      readonly postalCode: string;
      readonly countryCode: string;
    };
  };
  readonly paidAt: string | null;
  readonly rounds: readonly {
    readonly roundNumber: number;
    readonly fromTableLabel: string | null;
    readonly items: readonly {
      readonly displayName: string;
      readonly subtotalMinor: string;
      readonly reduced: "Comp" | "Discount" | "Points" | null;
      /**
       * Batch 60: some of the line's dishes on the house, not all ("1 of 2"): how many of how
       * many. Absent: the whole line (or an older server).
       */
      readonly compedQuantity?: number;
      /** Batch 63: how many of the dish (absent: an older server). */
      readonly quantity?: number;
    }[];
  }[];
  readonly subtotalMinor: string;
  /** Tax as the rounds were charged; the bill's tax rounding is on its own line. */
  readonly taxMinor: string;
  /** WP-2423 DEC-TAX-WHOLE-RECEIPT: the bill's tax rounding (older server: 0). */
  readonly taxRoundingMinor: string;
  /** WP-2423 取舍 18: what points took off, already out of the subtotal and tax (older server: 0). */
  readonly pointsUsedMinor: string;
  readonly ordersTotalMinor: string;
  readonly tipMinor: string;
  readonly roundingMinor: string;
  readonly paidMinor: string;
  /** Owner 2026-11-03: what went back from these payments (older server: 0). */
  readonly refundedMinor: string;
  readonly split: boolean;
  /**
   * Batch 61 (v15 b60 live, CRT60 B order 46): how many payments paid a split bill; only this
   * phone's own parts are listed (null: an older server, which listed every part).
   */
  readonly paymentCount: number | null;
  readonly payments: readonly {
    readonly partNumber: number | null;
    readonly method: Method;
    readonly totalMinor: string;
    /** Batch 61: this phone's own payment, with what of it went back to its card. */
    readonly yours: boolean;
    readonly refundedMinor: string;
    /** Of `refundedMinor`, still on its way (the card issuer has not confirmed it). */
    readonly refundPendingMinor: string;
  }[];
}

export class SettledTableReceiptError extends Error {
  constructor(readonly code: "none" | "unavailable") {
    super("settled table receipt " + code);
    this.name = "SettledTableReceiptError";
  }
}
const fail = (code: "none" | "unavailable" = "unavailable"): never => {
  throw new SettledTableReceiptError(code);
};
const minor = (value: unknown) =>
  typeof value === "string" && /^-?(0|[1-9][0-9]{0,15})$/u.test(value) ? value : fail();
const label = (value: unknown) =>
  value === null
    ? null
    : typeof value === "string" && /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(value)
      ? value
      : fail();
const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : fail();
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : fail();
const list = (value: unknown, maximum: number): readonly unknown[] =>
  Array.isArray(value) && value.length <= maximum ? value : fail();

/** Batch 63: a published name or address part (plain text, never markup). */
const plain = (value: unknown, maximum: number) =>
  typeof value === "string" &&
  value.trim() !== "" &&
  value.length <= maximum &&
  !/[\p{Cc}\p{Cf}<>]/u.test(value)
    ? value
    : fail();
function merchantOf(value: unknown): SettledTableReceipt["merchant"] {
  if (value === undefined) return null;
  const merchant = record(value);
  const address = record(merchant.address);
  return Object.freeze({
    brandDisplayName: plain(merchant.brandDisplayName, 200),
    storeDisplayName: plain(merchant.storeDisplayName, 200),
    address: Object.freeze({
      addressLines: Object.freeze(list(address.addressLines, 3).map((line) => plain(line, 160))),
      locality: plain(address.locality, 120),
      regionCode: plain(address.regionCode, 12),
      postalCode: plain(address.postalCode, 20),
      countryCode: plain(address.countryCode, 2),
    }),
  });
}

export function parseSettledTableReceipt(payload: unknown): SettledTableReceipt {
  const receipt = record(record(payload).receipt);
  return Object.freeze({
    tableLabel: label(receipt.tableLabel),
    merchant: merchantOf(receipt.merchant),
    paidAt:
      receipt.paidAt === undefined
        ? null
        : typeof receipt.paidAt === "string" &&
            receipt.paidAt.length <= 40 &&
            Number.isFinite(Date.parse(receipt.paidAt))
          ? receipt.paidAt
          : fail(),
    rounds: list(receipt.rounds, 200).map((value) => {
      const round = record(value);
      return Object.freeze({
        roundNumber:
          Number.isSafeInteger(round.roundNumber) && (round.roundNumber as number) >= 1
            ? (round.roundNumber as number)
            : fail(),
        fromTableLabel: label(round.fromTableLabel),
        items: list(round.items, 200).map((entry) => {
          const item = record(entry);
          const reduced =
            item.reduced === null ||
            item.reduced === "Comp" ||
            item.reduced === "Discount" ||
            item.reduced === "Points"
              ? item.reduced
              : fail();
          const count = (value: unknown) =>
            Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 999
              ? (value as number)
              : fail();
          // Batch 63: how many of the dish (absent from an older server: the line is said alone).
          const quantity = item.quantity === undefined ? undefined : count(item.quantity);
          const part =
            item.compedQuantity === undefined
              ? null
              : reduced === "Comp" && quantity !== undefined
                ? { compedQuantity: count(item.compedQuantity) }
                : fail();
          if (part !== null && quantity !== undefined && part.compedQuantity >= quantity) fail();
          return Object.freeze({
            displayName: text(item.displayName),
            subtotalMinor: minor(item.subtotalMinor),
            reduced,
            ...(quantity === undefined ? {} : { quantity }),
            ...(part ?? {}),
          });
        }),
      });
    }),
    subtotalMinor: minor(receipt.subtotalMinor),
    taxMinor: minor(receipt.taxMinor),
    taxRoundingMinor:
      receipt.taxRoundingMinor === undefined ? "0" : minor(receipt.taxRoundingMinor),
    pointsUsedMinor: receipt.pointsUsedMinor === undefined ? "0" : minor(receipt.pointsUsedMinor),
    ordersTotalMinor: minor(receipt.ordersTotalMinor),
    tipMinor: minor(receipt.tipMinor),
    roundingMinor: minor(receipt.roundingMinor),
    paidMinor: minor(receipt.paidMinor),
    refundedMinor: receipt.refundedMinor === undefined ? "0" : minor(receipt.refundedMinor),
    split: typeof receipt.split === "boolean" ? receipt.split : fail(),
    paymentCount:
      receipt.paymentCount === undefined
        ? null
        : Number.isSafeInteger(receipt.paymentCount) &&
            (receipt.paymentCount as number) >= 0 &&
            (receipt.paymentCount as number) <= 20
          ? (receipt.paymentCount as number)
          : fail(),
    payments: list(receipt.payments, 20).map((value) => {
      const payment = record(value);
      const yours = payment.yours === undefined ? false : payment.yours === true ? true : fail();
      const refundedMinor =
        payment.refundedMinor === undefined ? "0" : yours ? minor(payment.refundedMinor) : fail();
      const refundPendingMinor =
        payment.refundPendingMinor === undefined
          ? "0"
          : yours
            ? minor(payment.refundPendingMinor)
            : fail();
      if (BigInt(refundPendingMinor) > BigInt(refundedMinor)) fail();
      return Object.freeze({
        yours,
        refundedMinor,
        refundPendingMinor,
        partNumber:
          payment.partNumber === null
            ? null
            : Number.isSafeInteger(payment.partNumber) && (payment.partNumber as number) >= 1
              ? (payment.partNumber as number)
              : fail(),
        method:
          payment.method === "CardMachine" ||
          payment.method === "Cash" ||
          payment.method === "Online"
            ? payment.method
            : fail(),
        totalMinor: minor(payment.totalMinor),
      });
    }),
  });
}

export interface SettledTableReceiptClient {
  read(): Promise<SettledTableReceipt>;
}

export function createSettledTableReceiptClient(
  request: typeof fetch = globalThis.fetch,
): SettledTableReceiptClient {
  return Object.freeze({
    async read() {
      const csrf = getSettledTableReceiptCsrf();
      if (csrf === null) return fail("none");
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
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({
            action: "SettledReceipt",
            ...(nameLocale() === null ? {} : { locale: nameLocale() }),
          }),
        });
      } catch {
        return fail();
      }
      // Not found: a bill written off, or nothing to show for this phone.
      if (answer.response.status === 404) return fail("none");
      if (answer.response.status !== 200 || answer.payload === null) return fail();
      return parseSettledTableReceipt(answer.payload);
    },
  });
}

const money = (amountMinor: string) => formatMoney(amountMinor, "CAD");
const methodText = (method: Method) =>
  method === "Online"
    ? t("Online by phone")
    : method === "Cash"
      ? t("Cash")
      : t("Card at the table");

const netOf = (paidMinor: string, refundedMinor: string) => {
  const net = BigInt(paidMinor) - BigInt(refundedMinor);
  return (net > 0n ? net : 0n).toString();
};

/**
 * Batch 61: this phone's own part of a split bill — how and how much it paid, what of it went
 * back to its card (confirmed, and still on its way) and what it paid after refunds.
 */
function OwnPartRows({
  payment,
  label,
}: {
  readonly payment: SettledTableReceipt["payments"][number];
  /** Batch 63: under "Your payments", each row names its part. */
  readonly label?: string;
}) {
  const pending =
    BigInt(payment.refundPendingMinor) > BigInt(payment.refundedMinor)
      ? BigInt(payment.refundedMinor)
      : BigInt(payment.refundPendingMinor);
  const done = BigInt(payment.refundedMinor) - pending;
  return (
    <>
      <div>
        <dt>{label ?? t("Your payment")}</dt>
        <dd>
          {label === undefined
            ? `${methodText(payment.method)} · ${money(payment.totalMinor)}`
            : money(payment.totalMinor)}
        </dd>
      </div>
      {done > 0n ? (
        <div>
          <dt>{t("Refunded to your card")}</dt>
          <dd>−{money(done.toString())}</dd>
        </div>
      ) : null}
      {pending > 0n ? (
        <div>
          <dt>{t("On its way back to your card")}</dt>
          <dd>−{money(pending.toString())}</dd>
        </div>
      ) : null}
      {payment.refundedMinor === "0" ? null : (
        <div>
          <dt>{t("You paid after refunds")}</dt>
          <dd>{money(netOf(payment.totalMinor, payment.refundedMinor))}</dd>
        </div>
      )}
    </>
  );
}

export function SettledTableReceiptView({ receipt }: { readonly receipt: SettledTableReceipt }) {
  const yours = receipt.split ? receipt.payments.filter((payment) => payment.yours) : [];
  const yourCount = yours.length;
  const yourTotal = yours.reduce((sum, payment) => sum + BigInt(payment.totalMinor), 0n).toString();
  return (
    <section
      className="order-status__card dining-session__receipt dining-session__receipt--settled"
      aria-labelledby="table-receipt"
    >
      <h2 id="table-receipt">{t("Receipt")}</h2>
      {/* Batch 63 (design review D62B-03, F05): who it is from and when, as the pickup receipt
          says it, so the guest's printed or saved copy stands on its own. */}
      {receipt.merchant === null ? null : (
        <div className="dining-session__receipt-merchant">
          <p className="dining-session__receipt-store">{receipt.merchant.storeDisplayName}</p>
          {receipt.merchant.brandDisplayName === receipt.merchant.storeDisplayName ? null : (
            <p>{receipt.merchant.brandDisplayName}</p>
          )}
          <address>
            {receipt.merchant.address.addressLines.map((line) => (
              <span key={line}>{line}</span>
            ))}
            <span>{formatLocalityLine(receipt.merchant.address)}</span>
          </address>
          {receipt.tableLabel === null ? null : (
            <p>{t("Table {table}", { table: saidTable(receipt.tableLabel) })}</p>
          )}
          {receipt.paidAt === null ? null : (
            <p>{t("Paid {date}", { date: formatDateTime(receipt.paidAt) })}</p>
          )}
        </div>
      )}
      {receipt.rounds.map((round) => (
        <div key={round.roundNumber} className="dining-session__receipt-round">
          <h3>
            {t("Round {round}", { round: String(round.roundNumber) })}
            {round.fromTableLabel === null
              ? null
              : ` · ${t("From table {table}", { table: saidTable(round.fromTableLabel) })}`}
          </h3>
          <dl className="order-status__money">
            {round.items.map((item, index) => (
              <div key={index}>
                <dt>
                  {/* Batch 63 (D62B-02): "2 × Beef noodles", as the Rounds list says it. */}
                  {item.quantity === undefined
                    ? item.displayName
                    : `${item.quantity} × ${item.displayName}`}
                  {item.reduced === "Comp"
                    ? item.compedQuantity !== undefined && item.quantity !== undefined
                      ? ` · ${t("{comped} of {quantity} on the house", {
                          comped: String(item.compedQuantity),
                          quantity: String(item.quantity),
                        })}`
                      : ` · ${t("On the house")}`
                    : item.reduced === "Discount"
                      ? ` · ${t("Discounted")}`
                      : item.reduced === "Points"
                        ? ` · ${t("Points used")}`
                        : null}
                </dt>
                <dd>{money(item.subtotalMinor)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      <dl className="order-status__money">
        <div>
          <dt>{t("Subtotal before tax")}</dt>
          <dd>{money(receipt.subtotalMinor)}</dd>
        </div>
        {/* v15 batch 9 (DEC-TAX-WHOLE-RECEIPT): one receipt, one tax figure — the bill's tax
            worked out once over the whole bill (as the staff's paid bill prints it). */}
        <div>
          <dt>{t("Tax")}</dt>
          <dd>{money((BigInt(receipt.taxMinor) + BigInt(receipt.taxRoundingMinor)).toString())}</dd>
        </div>
        {receipt.pointsUsedMinor !== "0" ? (
          <div>
            <dt>{t("Points used (already taken off)")}</dt>
            <dd>−{money(receipt.pointsUsedMinor)}</dd>
          </div>
        ) : null}
        {receipt.tipMinor !== "0" ? (
          <div>
            <dt>{t("Tip")}</dt>
            <dd>{money(receipt.tipMinor)}</dd>
          </div>
        ) : null}
        {receipt.roundingMinor !== "0" ? (
          <div>
            <dt>{t("Cash rounding")}</dt>
            <dd>{money(receipt.roundingMinor)}</dd>
          </div>
        ) : null}
        {/* Batch 61 (v15 b60 live, CRT60 B): once some of it went back, what was paid, what went
            back and what the table paid after refunds, each named once (实付 never the gross). */}
        {receipt.refundedMinor === "0" ? (
          <div>
            <dt>{t("Total paid")}</dt>
            <dd>{money(receipt.paidMinor)}</dd>
          </div>
        ) : (
          <>
            <div>
              <dt>{t("Paid")}</dt>
              <dd>{money(receipt.paidMinor)}</dd>
            </div>
            <div>
              <dt>{t("Refunded")}</dt>
              <dd>−{money(receipt.refundedMinor)}</dd>
            </div>
            <div>
              <dt>{t("Total paid after refunds")}</dt>
              <dd>{money(netOf(receipt.paidMinor, receipt.refundedMinor))}</dd>
            </div>
          </>
        )}
        {/* b13: a table comped to nothing paid nothing, said as that. */}
        {receipt.paidMinor === "0" && receipt.payments.length === 0 ? (
          <div>
            <dt>{t("Nothing to pay")}</dt>
            <dd>{t("The restaurant took everything off.")}</dd>
          </div>
        ) : null}
        {/* Batch 61: a bill paid in parts says how many payments paid it; each phone sees only its
            own part's amount, method and refunds, never another guest's. */}
        {receipt.split && receipt.paymentCount !== null ? (
          <div>
            <dt>{t("Number of payments")}</dt>
            <dd>{String(receipt.paymentCount)}</dd>
          </div>
        ) : null}
        {receipt.payments.map((payment) =>
          receipt.split && payment.yours ? (
            yourCount > 1 ? null : (
              <OwnPartRows key={payment.partNumber ?? 0} payment={payment} />
            )
          ) : (
            <div key={payment.partNumber ?? 0}>
              <dt>
                {payment.partNumber === null
                  ? t("Paid by")
                  : t("Part {number} paid by", { number: String(payment.partNumber) })}
              </dt>
              <dd>
                {receipt.split
                  ? `${methodText(payment.method)} · ${money(payment.totalMinor)}`
                  : methodText(payment.method)}
              </dd>
            </div>
          ),
        )}
      </dl>
      {/* Batch 63 (design review D62B-08, F06): a phone that paid several parts reads them under
          one heading, each with its part, and what it paid in all — never "Your payment" twice. */}
      {yourCount > 1 ? (
        <div className="dining-session__receipt-round" aria-labelledby="table-your-payments">
          <h3 id="table-your-payments">{t("Your payments")}</h3>
          <dl className="order-status__money">
            {receipt.payments
              .filter((payment) => payment.yours)
              .map((payment) => (
                <OwnPartRows
                  key={payment.partNumber ?? 0}
                  payment={payment}
                  label={t("Part {number} · {method}", {
                    number: String(payment.partNumber ?? 1),
                    method: methodText(payment.method),
                  })}
                />
              ))}
            <div className="dining-session__you-pay-total">
              <dt>{t("Total paid by you")}</dt>
              <dd>{money(yourTotal)}</dd>
            </div>
          </dl>
        </div>
      ) : null}
    </section>
  );
}

/** Loads the settled table's receipt; nothing is shown when there is none (written off). */
export function SettledTableReceiptPanel({
  client: provided,
}: {
  readonly client?: SettledTableReceiptClient;
}) {
  const [client] = useState(() => provided ?? createSettledTableReceiptClient());
  const [state, setState] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly receipt: SettledTableReceipt }
    | { readonly status: "none" }
    | { readonly status: "unavailable" }
  >({ status: "loading" });
  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", receipt: await client.read() });
    } catch (error) {
      setState({
        status:
          error instanceof SettledTableReceiptError && error.code === "none"
            ? "none"
            : "unavailable",
      });
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  // v15 b16: dish names follow the language the guest switches to (the server writes them), as
  // the staff's Chinese screens show the dish's Chinese name.
  useReloadOnLanguageChange(() => void load());
  if (state.status === "none") return null;
  if (state.status === "loading") return <p role="status">{t("Loading receipt")}</p>;
  if (state.status === "unavailable")
    return (
      <section className="order-status__unavailable" role="alert">
        <p>{t("We couldn’t load the receipt. Check your connection and try again.")}</p>
        <button className="order-status__retry" type="button" onClick={() => void load()}>
          {t("Try again")}
        </button>
      </section>
    );
  return (
    <>
      <SettledTableReceiptView receipt={state.receipt} />
      <PrintTableReceipt />
      <MemberJoinPanel />
    </>
  );
}

/**
 * Batch 63 (design review D62B-03, F05): keep a copy of the table's receipt, as pickup offers —
 * the browser's print, which also saves a PDF. Only the receipt is printed (the page's tabs,
 * header, points offer and this action are left out).
 */
export function PrintTableReceipt() {
  const print = () => {
    const root = document.documentElement;
    root.dataset.printing = "table-receipt";
    const done = () => {
      delete root.dataset.printing;
      window.removeEventListener("afterprint", done);
    };
    window.addEventListener("afterprint", done);
    try {
      window.print();
    } finally {
      // Browsers that print synchronously have printed by now; afterprint may not come.
      window.setTimeout(done, 0);
    }
  };
  return (
    <p className="dining-session__receipt-print">
      <button type="button" onClick={print}>
        {t("Print or save receipt")}
      </button>
    </p>
  );
}
