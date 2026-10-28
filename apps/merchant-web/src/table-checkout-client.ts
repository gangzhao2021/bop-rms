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
  /** S4: a guest is paying the whole table on their phone right now. */
  | "GuestPaying"
  /** WP-2423 item 8 ④: the split can't change once a part was paid or a guest started paying. */
  | "SplitLocked"
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
      /** WP-2423 item 8 ① segment 2: a manager's comp or discount (tax included), or null. */
      readonly reduction: null | {
        readonly kind: "Comp" | "Percent" | "Amount";
        readonly percent: number | null;
        readonly amountMinor: string;
      };
    }[];
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
    readonly paid: boolean;
    /** WP-2423 item 8 ④: which phone sent the round (1, 2, …), or null for staff (older: null). */
    readonly orderedBy: number | null;
  }[];
  readonly owed: {
    readonly subtotalMinor: string;
    readonly taxMinor: string;
    readonly totalMinor: string;
  };
  readonly consistent: boolean;
  readonly settlement: null | {
    /** S4: "Online" — a guest paid the whole table on their phone. */
    readonly method: "CardMachine" | "Cash" | "Online";
    readonly roundsMinor: string;
    readonly tipMinor: string;
    readonly roundingMinor: string;
    readonly totalMinor: string;
    readonly tenderedMinor: string | null;
    readonly changeMinor: string | null;
    readonly recordedAt: string;
    readonly recordedAfterOutage: boolean;
  };
  /**
   * WP-2423 item 8 ④ DEC-DINE-IN-SPLIT-BILL: the bill split into parts paid one by one (null: one
   * payment for the table, or an older server). `stale`: split it again (the bill changed).
   */
  readonly split: null | TableSplit;
  /** DEC-DINE-IN-PAY-LATER: written off by a manager when the guests left (null from older). */
  readonly writeOff: null | { readonly amountMinor: string; readonly decidedAt: string };
  /** S4: the guests' latest phone payment for the table (null from older servers). */
  readonly onlinePayment: null | {
    readonly status: "InProgress" | "Captured" | "Failed" | "Cancelled";
    readonly totalMinor: string;
    readonly startedAt: string;
  };
}

export interface TableSplitPart {
  readonly partNumber: number;
  readonly amountMinor: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly roundNumbers: readonly number[];
  readonly payment: null | {
    readonly method: "CardMachine" | "Cash" | "Online";
    readonly tipMinor: string;
    readonly roundingMinor: string;
    readonly totalMinor: string;
    readonly tenderedMinor: string | null;
    readonly changeMinor: string | null;
    readonly recordedAt: string;
    readonly recordedAfterOutage: boolean;
  };
  readonly guestPaying: boolean;
}
export interface TableSplit {
  readonly mode: "Even" | "ByRounds";
  readonly stale: boolean;
  readonly parts: readonly TableSplitPart[];
  readonly paidParts: number;
  readonly remainingMinor: string;
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
                reduction: reductionOf(item.reduction),
              }),
            ),
          ),
          subtotalMinor: amount(round.subtotalMinor),
          taxMinor: amount(round.taxMinor),
          totalMinor: amount(round.totalMinor),
          paid: round.paid,
          orderedBy:
            round.orderedBy === undefined || round.orderedBy === null
              ? null
              : Number.isSafeInteger(round.orderedBy) && (round.orderedBy as number) >= 1
                ? (round.orderedBy as number)
                : invalid(),
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
              settlement.method === "Cash" ||
              settlement.method === "CardMachine" ||
              settlement.method === "Online"
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
    split: splitOf(raw.split),
    writeOff: writeOffOf(raw.writeOff),
    onlinePayment: onlinePaymentOf(raw.onlinePayment),
  });
}

function splitOf(value: unknown): TableSplit | null {
  if (value === undefined || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    (raw.mode !== "Even" && raw.mode !== "ByRounds") ||
    typeof raw.stale !== "boolean" ||
    !Array.isArray(raw.parts) ||
    raw.parts.length < 2 ||
    raw.parts.length > 20 ||
    !Number.isSafeInteger(raw.paidParts)
  )
    return invalid();
  return Object.freeze({
    mode: raw.mode,
    stale: raw.stale,
    paidParts: raw.paidParts as number,
    remainingMinor: amount(raw.remainingMinor),
    parts: Object.freeze(
      raw.parts.map((value: unknown, index: number) => {
        const part = value as Record<string, unknown>;
        if (
          part.partNumber !== index + 1 ||
          !Array.isArray(part.roundNumbers) ||
          typeof part.guestPaying !== "boolean"
        )
          return invalid();
        const payment = part.payment as Record<string, unknown> | null;
        return Object.freeze({
          partNumber: index + 1,
          amountMinor: amount(part.amountMinor),
          subtotalMinor: amount(part.subtotalMinor),
          taxMinor: amount(part.taxMinor),
          roundNumbers: Object.freeze(
            part.roundNumbers.map((round: unknown) =>
              Number.isSafeInteger(round) ? (round as number) : invalid(),
            ),
          ),
          payment:
            payment === null
              ? null
              : Object.freeze({
                  method:
                    payment.method === "Cash" ||
                    payment.method === "CardMachine" ||
                    payment.method === "Online"
                      ? payment.method
                      : invalid(),
                  tipMinor: amount(payment.tipMinor),
                  roundingMinor: amount(payment.roundingMinor),
                  totalMinor: amount(payment.totalMinor),
                  tenderedMinor:
                    payment.tenderedMinor === null ? null : amount(payment.tenderedMinor),
                  changeMinor: payment.changeMinor === null ? null : amount(payment.changeMinor),
                  recordedAt: text(payment.recordedAt),
                  recordedAfterOutage: payment.recordedAfterOutage === true,
                }),
          guestPaying: part.guestPaying,
        });
      }),
    ),
  });
}

function onlinePaymentOf(value: unknown): TableBill["onlinePayment"] {
  if (value === undefined || value === null) return null;
  const raw = value as Record<string, unknown>;
  if (
    !["InProgress", "Captured", "Failed", "Cancelled"].includes(String(raw.status)) ||
    typeof raw.totalMinor !== "string" ||
    !minor.test(raw.totalMinor) ||
    typeof raw.startedAt !== "string"
  )
    throw new TableCheckoutError("OutcomeUnknown");
  return Object.freeze({
    status: raw.status as "InProgress" | "Captured" | "Failed" | "Cancelled",
    totalMinor: raw.totalMinor,
    startedAt: raw.startedAt,
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
  guest_paying: "GuestPaying",
  split_locked: "SplitLocked",
  idempotency_conflict: "BillChanged",
  not_ready: "NotReady",
  not_at_checkout: "NotStarted",
  version_conflict: "BillChanged",
  already_closed: "AlreadyPaid",
};

function reductionOf(value: unknown) {
  // Absent from an older server: no comps then.
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") return invalid();
  const entry = value as Record<string, unknown>;
  if (
    (entry.kind !== "Comp" && entry.kind !== "Percent" && entry.kind !== "Amount") ||
    (entry.kind === "Percent" ? typeof entry.percent !== "number" : entry.percent !== null)
  )
    return invalid();
  return Object.freeze({
    kind: entry.kind,
    percent: entry.percent as number | null,
    amountMinor: amount(entry.amountMinor),
  });
}

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
        /** WP-2423 item 8 ④: the part of a split bill this payment is (null: the whole table). */
        readonly partNumber?: number | null;
      },
    ) {
      const { partNumber, ...rest } = command;
      const raw = (await post("/merchant/dining/table-settle", csrf, {
        ...rest,
        ...(partNumber === undefined || partNumber === null ? {} : { partNumber }),
        recordedAfterOutage: command.takenAt !== null,
      })) as { status?: unknown; bill?: unknown } | null;
      if (raw?.status !== "Recorded" && raw?.status !== "AlreadyRecorded") return invalid();
      return Object.freeze({ status: raw.status, bill: parseTableBill(raw.bill) });
    },
    /**
     * WP-2423 item 8 ④: split the table's bill evenly (2–20 people) or by rounds (each round to a
     * part), or go back to one payment ("Whole"). The server computes every part.
     */
    async split(
      csrf: string,
      command: {
        readonly operationReference: string;
        readonly diningSessionReference: string;
        readonly mode: "Whole" | "Even" | "ByRounds";
        readonly people: number | null;
        readonly rounds:
          readonly { readonly roundNumber: number; readonly partNumber: number }[] | null;
      },
    ) {
      const raw = (await post("/merchant/dining/table-split", csrf, command)) as {
        status?: unknown;
        bill?: unknown;
      } | null;
      if (raw?.status !== "Recorded" && raw?.status !== "AlreadyRecorded") return invalid();
      return parseTableBill(raw.bill);
    },
    /** S4: stop a phone payment a guest gave up on (the Provider is asked first). */
    async stopOnlinePayment(csrf: string, diningSessionReference: string) {
      const raw = (await post("/merchant/dining/table-online-payment/stop", csrf, {
        diningSessionReference,
      })) as { status?: unknown; bill?: unknown } | null;
      if (raw?.status !== "Stopped") return invalid();
      return parseTableBill(raw.bill);
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
