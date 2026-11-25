import { useCallback, useEffect, useState } from "react";
import { t, saidTable, nameLocale, useReloadOnLanguageChange } from "../i18n/i18n.js";
import { formatMoney } from "../journey/format.js";
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

export function parseSettledTableReceipt(payload: unknown): SettledTableReceipt {
  const receipt = record(record(payload).receipt);
  return Object.freeze({
    tableLabel: label(receipt.tableLabel),
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
          const part =
            item.compedQuantity === undefined
              ? null
              : reduced === "Comp"
                ? { compedQuantity: count(item.compedQuantity), quantity: count(item.quantity) }
                : fail();
          if (part !== null && part.compedQuantity >= part.quantity) fail();
          return Object.freeze({
            displayName: text(item.displayName),
            subtotalMinor: minor(item.subtotalMinor),
            reduced,
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
function OwnPartRows({ payment }: { readonly payment: SettledTableReceipt["payments"][number] }) {
  const pending =
    BigInt(payment.refundPendingMinor) > BigInt(payment.refundedMinor)
      ? BigInt(payment.refundedMinor)
      : BigInt(payment.refundPendingMinor);
  const done = BigInt(payment.refundedMinor) - pending;
  return (
    <>
      <div>
        <dt>{t("Your payment")}</dt>
        <dd>{`${methodText(payment.method)} · ${money(payment.totalMinor)}`}</dd>
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
  return (
    <section className="order-status__card dining-session__receipt" aria-labelledby="table-receipt">
      <h2 id="table-receipt">{t("Receipt")}</h2>
      {receipt.rounds.map((round) => (
        <div key={round.roundNumber}>
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
                  {item.displayName}
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
            <OwnPartRows key={payment.partNumber ?? 0} payment={payment} />
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
      <MemberJoinPanel />
    </>
  );
}
