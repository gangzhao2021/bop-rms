import { boundedFetch } from "../network/bounded-fetch.js";
import { withNameLocale } from "../i18n/i18n.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  getMovedTableLabel,
} from "../session/customer-transaction-context.js";

/** WP-2423 Q8 (CUST-DINE-IN-SESSION): the table's shared, read-only view for a joined guest. */
export interface DiningMoney {
  readonly amountMinor: string;
  readonly currencyCode: string;
}
export type DiningRoundStatus =
  | "AwaitingPayment"
  | "PaymentFailed"
  | "NotPaidCancelled"
  | "StoreCancelled"
  | "Received"
  | "Queued"
  | "Preparing"
  | "Ready"
  | "Serving"
  | "Served"
  /** WP-2423 item 8 ⑤: waits for staff before it goes to the kitchen (not owed yet). */
  | "WaitingForStaff";
export type DiningRoundPayment =
  | "Paid"
  | "Awaiting"
  | "Failed"
  | "NotCharged"
  | "Refunded"
  | "RefundPending"
  /** DEC-DINE-IN-PAY-LATER: in the kitchen; paid with the table's bill at the end. */
  | "OnTableBill";
export type DiningWaitingReason = "FirstOrder" | "PhoneRapid" | "TableRapid";
export type DiningCancellationReason =
  "CustomerRequest" | "SoldOut" | "StoreError" | "DuplicateOrder" | "GuestLeft";

export interface DiningRound {
  readonly roundNumber: number;
  /** WP-2423 Q7 slice 2: "Staff" — a round staff entered for the table. */
  readonly orderedBy: "You" | "AnotherGuest" | "Staff";
  readonly submittedAt: string;
  readonly status: DiningRoundStatus;
  readonly payment: DiningRoundPayment;
  readonly cancelsAt: string | null;
  readonly storeCancellationReason: DiningCancellationReason | null;
  /** WP-2423 item 8 ⑤: why the round waits for staff (status WaitingForStaff). */
  readonly waitingReason?: DiningWaitingReason;
  /** v15 2026-10-29: the round is only the per-head tea staff added (absent: not). */
  readonly tea?: true;
  readonly items: readonly {
    readonly displayName: string;
    readonly quantity: number;
    readonly servedQuantity: number;
    readonly cancelled: boolean;
    readonly lineTotal: DiningMoney;
    /** WP-2423 D5: the item's price before tax (every item has it, or none does). */
    readonly priceBeforeTax?: DiningMoney;
    /** WP-2423 Q26: the kitchen is making this item again. */
    readonly beingRemade?: boolean;
    /**
     * WP-2423 item 8 ③ (Owner decision 13): the published menu item and options "Order again"
     * adds to this guest's own cart; absent when it can't be read.
     */
    readonly orderAgain?: DiningOrderAgain;
  }[];
  /** WP-2423 D5: the round's items before tax and their tax (with priceBeforeTax). */
  readonly subtotal?: DiningMoney;
  readonly tax?: DiningMoney;
  readonly itemsTotal: DiningMoney;
}

export interface DiningOrderAgain {
  readonly sellableReference: string;
  readonly optionSelections: readonly {
    readonly optionReference: string;
    readonly quantity: number;
  }[];
}

const menuReference = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

function orderAgain(value: unknown): DiningOrderAgain {
  const entry = record(value, ["sellableReference", "optionSelections"]);
  if (
    typeof entry.sellableReference !== "string" ||
    !menuReference.test(entry.sellableReference) ||
    !Array.isArray(entry.optionSelections) ||
    entry.optionSelections.length > 50
  )
    return invalid();
  return Object.freeze({
    sellableReference: entry.sellableReference,
    optionSelections: Object.freeze(
      entry.optionSelections.map((raw: unknown) => {
        const option = record(raw, ["optionReference", "quantity"]);
        if (
          typeof option.optionReference !== "string" ||
          !menuReference.test(option.optionReference)
        )
          return invalid();
        return Object.freeze({
          optionReference: option.optionReference,
          quantity: count(option.quantity, 1),
        });
      }),
    ),
  });
}

export interface DiningSessionView {
  readonly tableLabel: string | null;
  readonly orderNumber: string | null;
  readonly checkedAt: string;
  /**
   * DEC-DINE-IN-PAY-LATER: PayLater — rounds go to the kitchen when sent and the table pays once
   * at the end; PayFirst — each round is paid as it is sent (also from an older server).
   */
  readonly paymentTiming: "PayFirst" | "PayLater";
  readonly rounds: readonly DiningRound[];
  readonly summary: null | {
    readonly paid: DiningMoney;
    readonly refunded: DiningMoney;
    readonly refundPending: DiningMoney;
    /** WP-2423 item 8 ⑦ 4b-3: the per-head tea on the bill (staff's; guests don't add it). */
    readonly teaCharge?: { readonly perGuest: DiningMoney; readonly guests: number };
    readonly due: DiningMoney;
    /** DEC-DINE-IN-PAY-LATER: the tip and cash rounding of the table's one payment, once paid. */
    readonly tableTip?: DiningMoney;
    readonly cashRounding?: DiningMoney;
    /** WP-2423 item 8 ④: the table pays in parts — how many, and how many are paid. */
    readonly splitParts?: { readonly count: number; readonly paid: number };
    /** WP-2423 D5: what the table ordered: items before tax, tax and total including tax. */
    readonly ordered?: {
      readonly subtotal: DiningMoney;
      readonly tax: DiningMoney;
      readonly total: DiningMoney;
    };
  };
}

/** "processing": the table's first round was just sent and its order is still being prepared. */
/** "moved" (WP-2423 item 8 ⑧): staff moved the party to `tableLabel` after this phone joined. */
export type DiningSessionClientErrorCode = "not-joined" | "processing" | "moved" | "unavailable";
export class DiningSessionClientError extends Error {
  constructor(
    readonly code: DiningSessionClientErrorCode,
    readonly tableLabel: string | null = null,
  ) {
    super("dining session is " + code);
    this.name = "DiningSessionClientError";
  }
}

export interface DiningSessionClient {
  load(signal?: AbortSignal): Promise<DiningSessionView>;
}

const credential = /^[A-Za-z0-9_-]{43}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const safeText = /^[^\p{Cc}\p{Cf}<>]{1,200}$/u;
const statuses: readonly DiningRoundStatus[] = [
  "AwaitingPayment",
  "PaymentFailed",
  "NotPaidCancelled",
  "StoreCancelled",
  "Received",
  "Queued",
  "Preparing",
  "Ready",
  "Serving",
  "Served",
  "WaitingForStaff",
];
const payments: readonly DiningRoundPayment[] = [
  "Paid",
  "Awaiting",
  "Failed",
  "NotCharged",
  "Refunded",
  "RefundPending",
  "OnTableBill",
];
const reasons: readonly DiningCancellationReason[] = [
  "CustomerRequest",
  "SoldOut",
  "StoreError",
  "DuplicateOrder",
  "GuestLeft",
];

function invalid(): never {
  throw new DiningSessionClientError("unavailable");
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const own = Object.keys(value);
  if (own.length !== keys.length || own.some((key) => !keys.includes(key))) return invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  return typeof value === "string" && safeText.test(value) ? value : invalid();
}
function time(value: unknown): string {
  return typeof value === "string" && instant.test(value) && Number.isFinite(Date.parse(value))
    ? value
    : invalid();
}
function count(value: unknown, minimum: number): number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= 999
    ? (value as number)
    : invalid();
}
function money(value: unknown): DiningMoney {
  const raw = record(value, ["amountMinor", "currencyCode"]);
  if (
    typeof raw.amountMinor !== "string" ||
    !/^(?:0|-?[1-9][0-9]{0,18})$/u.test(raw.amountMinor) ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode)
  )
    return invalid();
  return Object.freeze({ amountMinor: raw.amountMinor, currencyCode: raw.currencyCode });
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T {
  return allowed.includes(value as T) ? (value as T) : invalid();
}

export function parseDiningSessionView(value: unknown): DiningSessionView {
  const root = record(value, ["schemaVersion", "session"]);
  if (root.schemaVersion !== 1) return invalid();
  const timed =
    root.session !== null &&
    typeof root.session === "object" &&
    Object.hasOwn(root.session, "paymentTiming");
  const session = record(root.session, [
    "tableLabel",
    "orderNumber",
    "checkedAt",
    ...(timed ? ["paymentTiming"] : []),
    "rounds",
    "summary",
  ]);
  if (!Array.isArray(session.rounds) || session.rounds.length > 100) return invalid();
  const rounds = session.rounds.map((value: unknown, index): DiningRound => {
    const priced = value !== null && typeof value === "object" && Object.hasOwn(value, "subtotal");
    const waiting =
      value !== null && typeof value === "object" && Object.hasOwn(value, "waitingReason");
    const tea = value !== null && typeof value === "object" && Object.hasOwn(value, "tea");
    const round = record(value, [
      ...(priced ? ["subtotal", "tax"] : []),
      ...(waiting ? ["waitingReason"] : []),
      ...(tea ? ["tea"] : []),
      "roundNumber",
      "orderedBy",
      "submittedAt",
      "status",
      "payment",
      "cancelsAt",
      "storeCancellationReason",
      "items",
      "itemsTotal",
    ]);
    if (round.roundNumber !== index + 1) return invalid();
    if (!Array.isArray(round.items) || round.items.length < 1 || round.items.length > 100)
      return invalid();
    const itemsTotal = money(round.itemsTotal);
    const items = Object.freeze(
      round.items.map((value: unknown) => {
        const remade =
          value !== null && typeof value === "object" && Object.hasOwn(value, "beingRemade");
        const again =
          value !== null && typeof value === "object" && Object.hasOwn(value, "orderAgain");
        const item = record(value, [
          "displayName",
          "quantity",
          "servedQuantity",
          "cancelled",
          "lineTotal",
          ...(priced ? ["priceBeforeTax"] : []),
          ...(remade ? ["beingRemade"] : []),
          ...(again ? ["orderAgain"] : []),
        ]);
        if (remade && item.beingRemade !== true) return invalid();
        const quantity = count(item.quantity, 1);
        const servedQuantity = count(item.servedQuantity, 0);
        if (servedQuantity > quantity || typeof item.cancelled !== "boolean") return invalid();
        const lineTotal = money(item.lineTotal);
        const priceBeforeTax = priced ? money(item.priceBeforeTax) : null;
        if (
          priceBeforeTax !== null &&
          (priceBeforeTax.currencyCode !== lineTotal.currencyCode ||
            BigInt(priceBeforeTax.amountMinor) < 0n)
        )
          return invalid();
        return Object.freeze({
          displayName: text(item.displayName),
          quantity,
          servedQuantity,
          cancelled: item.cancelled,
          lineTotal,
          ...(priceBeforeTax === null ? {} : { priceBeforeTax }),
          ...(remade ? { beingRemade: true } : {}),
          ...(again ? { orderAgain: orderAgain(item.orderAgain) } : {}),
        });
      }),
    );
    // WP-2423 D5: the round's subtotal is its items before tax; with its tax it stays within the
    // round total (any difference is a discount or fee the items carried).
    let breakdown: { subtotal: DiningMoney; tax: DiningMoney } | null = null;
    if (priced) {
      const subtotal = money(round.subtotal),
        tax = money(round.tax);
      if (
        subtotal.currencyCode !== itemsTotal.currencyCode ||
        tax.currencyCode !== itemsTotal.currencyCode ||
        BigInt(tax.amountMinor) < 0n ||
        BigInt(subtotal.amountMinor) !==
          items.reduce((sum, item) => sum + BigInt(item.priceBeforeTax?.amountMinor ?? "0"), 0n)
      )
        return invalid();
      breakdown = { subtotal, tax };
    }
    return Object.freeze({
      roundNumber: index + 1,
      orderedBy: oneOf(round.orderedBy, ["You", "AnotherGuest", "Staff"] as const),
      submittedAt: time(round.submittedAt),
      status: oneOf(round.status, statuses),
      payment: oneOf(round.payment, payments),
      cancelsAt: round.cancelsAt === null ? null : time(round.cancelsAt),
      storeCancellationReason:
        round.storeCancellationReason === null
          ? null
          : oneOf(round.storeCancellationReason, reasons),
      ...(waiting
        ? {
            waitingReason: oneOf(round.waitingReason, [
              "FirstOrder",
              "PhoneRapid",
              "TableRapid",
            ] as const),
          }
        : {}),
      ...(tea ? { tea: round.tea === true ? (true as const) : invalid() } : {}),
      items,
      ...(breakdown === null ? {} : breakdown),
      itemsTotal,
    });
  });
  let summary: DiningSessionView["summary"] = null;
  if (session.summary !== null) {
    const withOrdered =
      session.summary !== null &&
      typeof session.summary === "object" &&
      Object.hasOwn(session.summary, "ordered");
    const withSettlement =
      session.summary !== null &&
      typeof session.summary === "object" &&
      Object.hasOwn(session.summary, "cashRounding");
    const withSplit =
      session.summary !== null &&
      typeof session.summary === "object" &&
      Object.hasOwn(session.summary, "splitParts");
    const withTea =
      session.summary !== null &&
      typeof session.summary === "object" &&
      Object.hasOwn(session.summary, "teaCharge");
    const raw = record(session.summary, [
      ...(withTea ? ["teaCharge"] : []),
      ...(withSettlement ? ["tableTip", "cashRounding"] : []),
      ...(withSplit ? ["splitParts"] : []),
      "paid",
      "refunded",
      "refundPending",
      "due",
      ...(withOrdered ? ["ordered"] : []),
    ]);
    let ordered: { subtotal: DiningMoney; tax: DiningMoney; total: DiningMoney } | null = null;
    if (withOrdered) {
      // Only with every round priced; the table's subtotal is the priced rounds' (never a guess).
      if (rounds.some((round) => round.subtotal === undefined)) return invalid();
      const entry = record(raw.ordered, ["subtotal", "tax", "total"]);
      ordered = Object.freeze({
        subtotal: money(entry.subtotal),
        tax: money(entry.tax),
        total: money(entry.total),
      });
      if (BigInt(ordered.subtotal.amountMinor) < 0n || BigInt(ordered.tax.amountMinor) < 0n)
        return invalid();
    } else if (rounds.some((round) => round.subtotal !== undefined)) return invalid();
    summary = Object.freeze({
      paid: money(raw.paid),
      refunded: money(raw.refunded),
      refundPending: money(raw.refundPending),
      due: money(raw.due),
      ...(ordered === null ? {} : { ordered }),
      ...(withSettlement
        ? { tableTip: money(raw.tableTip), cashRounding: money(raw.cashRounding) }
        : {}),
      ...(withTea
        ? (() => {
            const tea = record(raw.teaCharge, ["perGuest", "guests"]);
            return {
              teaCharge: Object.freeze({
                perGuest: money(tea.perGuest),
                guests: count(tea.guests, 1),
              }),
            };
          })()
        : {}),
      ...(withSplit
        ? (() => {
            const parts = record(raw.splitParts, ["count", "paid"]);
            const total = count(parts.count, 2),
              paid = count(parts.paid, 0);
            if (paid > total) return invalid();
            return { splitParts: Object.freeze({ count: total, paid }) };
          })()
        : {}),
    });
  }
  if ((summary === null) !== (rounds.length === 0)) return invalid();
  return Object.freeze({
    tableLabel:
      session.tableLabel === null
        ? null
        : typeof session.tableLabel === "string" && session.tableLabel.length <= 40
          ? text(session.tableLabel)
          : invalid(),
    orderNumber:
      session.orderNumber === null
        ? null
        : typeof session.orderNumber === "string" &&
            /^[0-9A-Za-z-]{1,20}$/u.test(session.orderNumber)
          ? session.orderNumber
          : invalid(),
    checkedAt: time(session.checkedAt),
    paymentTiming: timed
      ? oneOf(session.paymentTiming, ["PayFirst", "PayLater"] as const)
      : "PayFirst",
    rounds: Object.freeze(rounds),
    summary,
  });
}

export function createHttpDiningSessionClient(
  request: typeof globalThis.fetch = globalThis.fetch,
): DiningSessionClient {
  const once = async (signal?: AbortSignal) => {
    const csrf = getCustomerCsrfCredential();
    const current = captureCustomerCsrfContext();
    // Without this browser's session there is no table to show (not an error to retry), unless
    // staff moved its party since it joined (v15 2026-10-30: told on restoring the visit).
    if (csrf === null || !credential.test(csrf)) {
      const moved = getMovedTableLabel();
      if (moved !== null) throw new DiningSessionClientError("moved", moved);
      throw new DiningSessionClientError("not-joined");
    }
    let response: Response;
    try {
      response = await boundedFetch(request, withNameLocale("/api/v1/dine-in/session"), {
        method: "GET",
        credentials: "include",
        cache: "no-store",
        redirect: "error",
        headers: { accept: "application/json", "x-csrf-token": csrf },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new DiningSessionClientError("unavailable");
    }
    if (!current()) throw new DiningSessionClientError("not-joined");
    if (response.status === 404 || response.status === 403 || response.status === 401)
      throw new DiningSessionClientError("not-joined");
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: unknown };
        tableLabel?: unknown;
      } | null;
      if (
        body?.error?.code === "dining_table_moved" &&
        typeof body.tableLabel === "string" &&
        /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(body.tableLabel)
      )
        throw new DiningSessionClientError("moved", body.tableLabel);
    }
    if (response.status === 503) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: unknown };
      } | null;
      if (body?.error?.code === "dining_session_order_processing")
        throw new DiningSessionClientError("processing");
    }
    if (response.status !== 200) throw new DiningSessionClientError("unavailable");
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DiningSessionClientError("unavailable");
    }
    if (!current()) throw new DiningSessionClientError("not-joined");
    return parseDiningSessionView(payload);
  };
  return Object.freeze({
    async load(signal?: AbortSignal) {
      const started = captureCustomerCsrfContext();
      try {
        return await once(signal);
      } catch (error) {
        // WP-2423 (v15 2026-10-27): the browser's session credential was replaced while this read
        // ran (right after a round was sent): read again with the current one, never "not joined".
        if (
          error instanceof DiningSessionClientError &&
          error.code === "not-joined" &&
          !started() &&
          signal?.aborted !== true
        )
          return once(signal);
        throw error;
      }
    },
  });
}
