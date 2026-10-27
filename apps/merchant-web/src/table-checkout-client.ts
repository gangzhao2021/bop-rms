/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a pay-later table's bill, its one payment (card machine or cash)
 * and a manager's "left without paying" decision. Amounts are minor units as strings; the server
 * prices everything (the browser sends intent only: method, tip choice, cash handed over).
 */
export type TableCheckoutErrorCode =
  | "PermissionDenied"
  | "NotStarted"
  | "NotPayLater"
  | "NothingOwed"
  | "BillChanged"
  | "TenderShort"
  | "AlreadyPaid"
  | "NotReady"
  | "Unavailable"
  | "OutcomeUnknown";
export class TableCheckoutError extends Error {
  constructor(
    readonly code: TableCheckoutErrorCode,
    readonly reasons: readonly string[] = [],
  ) {
    super("table checkout " + code);
    this.name = "TableCheckoutError";
  }
}

export interface TableBill {
  readonly diningSessionReference: string;
  readonly sessionPhase: "Active" | "Closing" | "Closed" | "Cancelled";
  readonly sessionVersion: number;
  readonly paymentTiming: "PayFirst" | "PayLater";
  readonly tableLabel: string | null;
  readonly orderReference: string | null;
  readonly rounds: readonly {
    readonly roundNumber: number;
    readonly items: readonly {
      readonly displayName: string;
      readonly subtotalMinor: string;
      readonly totalMinor: string;
    }[];
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
    readonly paid: boolean;
  }[];
  readonly owed: {
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
  };
  readonly consistent: boolean;
  readonly settlement: null | {
    readonly method: "CardMachine" | "Cash";
    readonly roundsMinor: string;
    readonly tipMinor: string;
    readonly roundingMinor: string;
    readonly totalMinor: string;
    readonly tenderedMinor: string | null;
    readonly changeMinor: string | null;
    readonly recordedAt: string;
    readonly recordedAfterOutage: boolean;
  };
  /** DEC-DINE-IN-PAY-LATER: written off by a manager when the guests left (null from older). */
  readonly writeOff: null | { readonly amountMinor: string; readonly decidedAt: string };
}

const minor = /^-?(?:0|[1-9][0-9]{0,18})$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const invalid = (): never => {
  throw new TableCheckoutError("Unavailable");
};
const amount = (value: unknown) =>
  typeof value === "string" && minor.test(value) ? value : invalid();
const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 && value.length <= 200 ? value : invalid();

export function parseTableBill(value: unknown): TableBill {
  if (value === null || typeof value !== "object") return invalid();
  const raw = value as Record<string, unknown>;
  if (
    typeof raw.diningSessionReference !== "string" ||
    !reference.test(raw.diningSessionReference) ||
    !["Active", "Closing", "Closed", "Cancelled"].includes(String(raw.sessionPhase)) ||
    !Number.isSafeInteger(raw.sessionVersion) ||
    (raw.paymentTiming !== "PayFirst" && raw.paymentTiming !== "PayLater") ||
    typeof raw.consistent !== "boolean" ||
    !Array.isArray(raw.rounds) ||
    raw.rounds.length > 200
  )
    return invalid();
  const owed = raw.owed as Record<string, unknown>;
  const settlement = raw.settlement as Record<string, unknown> | null;
  return Object.freeze({
    diningSessionReference: raw.diningSessionReference,
    sessionPhase: raw.sessionPhase as TableBill["sessionPhase"],
    sessionVersion: raw.sessionVersion as number,
    paymentTiming: raw.paymentTiming,
    tableLabel: raw.tableLabel === null ? null : text(raw.tableLabel),
    orderReference:
      raw.orderReference === null
        ? null
        : typeof raw.orderReference === "string" && reference.test(raw.orderReference)
          ? raw.orderReference
          : invalid(),
    rounds: Object.freeze(
      raw.rounds.map((value: unknown) => {
        const round = value as Record<string, unknown>;
        if (
          !Number.isSafeInteger(round.roundNumber) ||
          typeof round.paid !== "boolean" ||
          !Array.isArray(round.items)
        )
          return invalid();
        return Object.freeze({
          roundNumber: round.roundNumber as number,
          items: Object.freeze(
            round.items.map((item: Record<string, unknown>) =>
              Object.freeze({
                displayName: text(item.displayName),
                subtotalMinor: amount(item.subtotalMinor),
                totalMinor: amount(item.totalMinor),
              }),
            ),
          ),
          subtotalMinor: amount(round.subtotalMinor),
          taxMinor: amount(round.taxMinor),
          totalMinor: amount(round.totalMinor),
          paid: round.paid,
        });
      }),
    ),
    owed: Object.freeze({
      subtotalMinor: amount(owed?.subtotalMinor),
      taxMinor: amount(owed?.taxMinor),
      totalMinor: amount(owed?.totalMinor),
    }),
    consistent: raw.consistent,
    settlement:
      settlement === null
        ? null
        : Object.freeze({
            method:
              settlement.method === "Cash" || settlement.method === "CardMachine"
                ? settlement.method
                : invalid(),
            roundsMinor: amount(settlement.roundsMinor),
            tipMinor: amount(settlement.tipMinor),
            roundingMinor: amount(settlement.roundingMinor),
            totalMinor: amount(settlement.totalMinor),
            tenderedMinor:
              settlement.tenderedMinor === null ? null : amount(settlement.tenderedMinor),
            changeMinor: settlement.changeMinor === null ? null : amount(settlement.changeMinor),
            recordedAt: text(settlement.recordedAt),
            recordedAfterOutage: settlement.recordedAfterOutage === true,
          }),
    writeOff: writeOffOf(raw.writeOff),
  });
}

function writeOffOf(value: unknown): TableBill["writeOff"] {
  if (value === undefined || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.amountMinor !== "string" || !minor.test(raw.amountMinor))
    throw new TableCheckoutError("OutcomeUnknown");
  if (typeof raw.decidedAt !== "string") throw new TableCheckoutError("OutcomeUnknown");
  return Object.freeze({ amountMinor: raw.amountMinor, decidedAt: raw.decidedAt });
}

/** Canada's cash rounding (as the server applies it): to the nearest 5 cents by the last digit. */
export function cashTotalMinor(totalMinor: bigint): bigint {
  const digit = totalMinor % 10n;
  if (digit === 0n || digit === 5n) return totalMinor;
  if (digit <= 2n) return totalMinor - digit;
  if (digit <= 7n) return totalMinor + 5n - digit;
  return totalMinor + 10n - digit;
}

const codes: Readonly<Record<string, TableCheckoutErrorCode>> = {
  not_started: "NotStarted",
  not_pay_later: "NotPayLater",
  nothing_owed: "NothingOwed",
  bill_changed: "BillChanged",
  tender_short: "TenderShort",
  already_paid: "AlreadyPaid",
  idempotency_conflict: "BillChanged",
  not_ready: "NotReady",
  not_at_checkout: "NotStarted",
  version_conflict: "BillChanged",
  already_closed: "AlreadyPaid",
};

export function createTableCheckoutClient(fetcher: typeof fetch = fetch) {
  const post = async (path: string, csrf: string, body: unknown, signal?: AbortSignal) => {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(csrf)) throw new TableCheckoutError("Unavailable");
    let response: Response;
    try {
      response = await fetcher(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        signal: signal ?? null,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-BOP-CSRF": csrf,
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new TableCheckoutError("OutcomeUnknown");
    }
    if (response.status === 401 || response.status === 403)
      throw new TableCheckoutError("PermissionDenied");
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const body = (payload ?? {}) as { error?: unknown; reasons?: unknown };
      const code = typeof body.error === "string" ? codes[body.error] : undefined;
      if (response.status >= 500 && code === undefined)
        throw new TableCheckoutError("OutcomeUnknown");
      throw new TableCheckoutError(
        code ?? "Unavailable",
        Array.isArray(body.reasons)
          ? body.reasons.filter((r): r is string => typeof r === "string")
          : [],
      );
    }
    if (response.headers.get("cache-control") !== "no-store")
      throw new TableCheckoutError("Unavailable");
    return payload;
  };
  return Object.freeze({
    async bill(csrf: string, diningSessionReference: string, signal?: AbortSignal) {
      return parseTableBill(
        await post("/merchant/dining/table-bill", csrf, { diningSessionReference }, signal),
      );
    },
    async settle(
      csrf: string,
      command: {
        readonly operationReference: string;
        readonly diningSessionReference: string;
        readonly method: "CardMachine" | "Cash";
        readonly tip:
          | { readonly kind: "None" }
          | { readonly kind: "Percent"; readonly percent: 10 | 15 | 18 | 20 }
          | { readonly kind: "Amount"; readonly amountMinor: string };
        readonly tenderedMinor: string | null;
        readonly slipReference: string | null;
        /** Paid while the system was down (paper), at this instant; null when paid now. */
        readonly takenAt: string | null;
      },
    ) {
      const raw = (await post("/merchant/dining/table-settle", csrf, {
        ...command,
        recordedAfterOutage: command.takenAt !== null,
      })) as { status?: unknown; bill?: unknown } | null;
      if (raw?.status !== "Recorded" && raw?.status !== "AlreadyRecorded") return invalid();
      return Object.freeze({ status: raw.status, bill: parseTableBill(raw.bill) });
    },
    async leftWithoutPaying(
      csrf: string,
      command: {
        readonly orderReference: string;
        readonly operationReference: string;
        readonly expectedOrderVersion: number;
        readonly expectedClosureVersion: number;
      },
    ) {
      const raw = (await post("/merchant/orders/close-unpaid-departure", csrf, command)) as {
        status?: unknown;
        writtenOffMinor?: unknown;
      } | null;
      if (raw?.status !== "Recorded" && raw?.status !== "AlreadyRecorded") return invalid();
      return Object.freeze({ status: raw.status, writtenOffMinor: amount(raw.writtenOffMinor) });
    },
  });
}
