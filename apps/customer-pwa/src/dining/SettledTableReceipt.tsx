import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n/i18n.js";
import { formatMoney } from "../journey/format.js";
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
      readonly reduced: "Comp" | "Discount" | null;
    }[];
  }[];
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly ordersTotalMinor: string;
  readonly tipMinor: string;
  readonly roundingMinor: string;
  readonly paidMinor: string;
  readonly split: boolean;
  readonly payments: readonly {
    readonly partNumber: number | null;
    readonly method: Method;
    readonly totalMinor: string;
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
          return Object.freeze({
            displayName: text(item.displayName),
            subtotalMinor: minor(item.subtotalMinor),
            reduced:
              item.reduced === null || item.reduced === "Comp" || item.reduced === "Discount"
                ? item.reduced
                : fail(),
          });
        }),
      });
    }),
    subtotalMinor: minor(receipt.subtotalMinor),
    taxMinor: minor(receipt.taxMinor),
    ordersTotalMinor: minor(receipt.ordersTotalMinor),
    tipMinor: minor(receipt.tipMinor),
    roundingMinor: minor(receipt.roundingMinor),
    paidMinor: minor(receipt.paidMinor),
    split: typeof receipt.split === "boolean" ? receipt.split : fail(),
    payments: list(receipt.payments, 20).map((value) => {
      const payment = record(value);
      return Object.freeze({
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
      let response: Response;
      try {
        response = await request("/api/v1/dine-in/table-payment", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          redirect: "error",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "x-csrf-token": csrf,
          },
          body: JSON.stringify({ action: "SettledReceipt" }),
        });
      } catch {
        return fail();
      }
      // Not found: a bill written off, or nothing to show for this phone.
      if (response.status === 404) return fail("none");
      if (response.status !== 200) return fail();
      return parseSettledTableReceipt(await response.json().catch(() => fail()));
    },
  });
}

const money = (amountMinor: string) => formatMoney(amountMinor, "CAD");
const methodText = (method: Method) =>
  method === "Online"
    ? t("Card on a guest’s phone")
    : method === "Cash"
      ? t("Cash")
      : t("Card at the table");

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
              : ` · ${t("From table {table}", { table: round.fromTableLabel })}`}
          </h3>
          <dl className="order-status__money">
            {round.items.map((item, index) => (
              <div key={index}>
                <dt>
                  {item.displayName}
                  {item.reduced === "Comp"
                    ? ` · ${t("On the house")}`
                    : item.reduced === "Discount"
                      ? ` · ${t("Discounted")}`
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
        <div>
          <dt>{t("Tax")}</dt>
          <dd>{money(receipt.taxMinor)}</dd>
        </div>
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
        <div>
          <dt>{t("Total paid")}</dt>
          <dd>{money(receipt.paidMinor)}</dd>
        </div>
        {receipt.payments.map((payment) => (
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
        ))}
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
  return <SettledTableReceiptView receipt={state.receipt} />;
}
