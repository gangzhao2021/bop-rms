import { boundedFetch } from "../network/bounded-fetch.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
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
  | "Served";
export type DiningRoundPayment =
  "Paid" | "Awaiting" | "Failed" | "NotCharged" | "Refunded" | "RefundPending";
export type DiningCancellationReason =
  "CustomerRequest" | "SoldOut" | "StoreError" | "DuplicateOrder";

export interface DiningRound {
  readonly roundNumber: number;
  readonly orderedBy: "You" | "AnotherGuest";
  readonly submittedAt: string;
  readonly status: DiningRoundStatus;
  readonly payment: DiningRoundPayment;
  readonly cancelsAt: string | null;
  readonly storeCancellationReason: DiningCancellationReason | null;
  readonly items: readonly {
    readonly displayName: string;
    readonly quantity: number;
    readonly servedQuantity: number;
    readonly cancelled: boolean;
    readonly lineTotal: DiningMoney;
  }[];
  readonly itemsTotal: DiningMoney;
}

export interface DiningSessionView {
  readonly tableLabel: string | null;
  readonly orderNumber: string | null;
  readonly checkedAt: string;
  readonly rounds: readonly DiningRound[];
  readonly summary: null | {
    readonly paid: DiningMoney;
    readonly refunded: DiningMoney;
    readonly refundPending: DiningMoney;
    readonly due: DiningMoney;
  };
}

export type DiningSessionClientErrorCode = "not-joined" | "unavailable";
export class DiningSessionClientError extends Error {
  constructor(readonly code: DiningSessionClientErrorCode) {
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
];
const payments: readonly DiningRoundPayment[] = [
  "Paid",
  "Awaiting",
  "Failed",
  "NotCharged",
  "Refunded",
  "RefundPending",
];
const reasons: readonly DiningCancellationReason[] = [
  "CustomerRequest",
  "SoldOut",
  "StoreError",
  "DuplicateOrder",
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
  const session = record(root.session, [
    "tableLabel",
    "orderNumber",
    "checkedAt",
    "rounds",
    "summary",
  ]);
  if (!Array.isArray(session.rounds) || session.rounds.length > 100) return invalid();
  const rounds = session.rounds.map((value: unknown, index): DiningRound => {
    const round = record(value, [
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
    return Object.freeze({
      roundNumber: index + 1,
      orderedBy: oneOf(round.orderedBy, ["You", "AnotherGuest"] as const),
      submittedAt: time(round.submittedAt),
      status: oneOf(round.status, statuses),
      payment: oneOf(round.payment, payments),
      cancelsAt: round.cancelsAt === null ? null : time(round.cancelsAt),
      storeCancellationReason:
        round.storeCancellationReason === null
          ? null
          : oneOf(round.storeCancellationReason, reasons),
      items: Object.freeze(
        round.items.map((value: unknown) => {
          const item = record(value, [
            "displayName",
            "quantity",
            "servedQuantity",
            "cancelled",
            "lineTotal",
          ]);
          const quantity = count(item.quantity, 1);
          const servedQuantity = count(item.servedQuantity, 0);
          if (servedQuantity > quantity || typeof item.cancelled !== "boolean") return invalid();
          return Object.freeze({
            displayName: text(item.displayName),
            quantity,
            servedQuantity,
            cancelled: item.cancelled,
            lineTotal: money(item.lineTotal),
          });
        }),
      ),
      itemsTotal: money(round.itemsTotal),
    });
  });
  let summary: DiningSessionView["summary"] = null;
  if (session.summary !== null) {
    const raw = record(session.summary, ["paid", "refunded", "refundPending", "due"]);
    summary = Object.freeze({
      paid: money(raw.paid),
      refunded: money(raw.refunded),
      refundPending: money(raw.refundPending),
      due: money(raw.due),
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
    rounds: Object.freeze(rounds),
    summary,
  });
}

export function createHttpDiningSessionClient(
  request: typeof globalThis.fetch = globalThis.fetch,
): DiningSessionClient {
  return Object.freeze({
    async load(signal?: AbortSignal) {
      const csrf = getCustomerCsrfCredential();
      const current = captureCustomerCsrfContext();
      // Without this browser's session there is no table to show (not an error to retry).
      if (csrf === null || !credential.test(csrf)) throw new DiningSessionClientError("not-joined");
      let response: Response;
      try {
        response = await boundedFetch(request, "/api/v1/dine-in/session", {
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
      if (response.status !== 200) throw new DiningSessionClientError("unavailable");
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new DiningSessionClientError("unavailable");
      }
      if (!current()) throw new DiningSessionClientError("not-joined");
      return parseDiningSessionView(payload);
    },
  });
}
