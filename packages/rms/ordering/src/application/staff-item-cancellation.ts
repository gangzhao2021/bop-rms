import { readClosedRecord } from "@bop/identity";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import {
  parseStaffOrderCancellationReasonCode,
  StaffOrderCancellationError,
  type StaffOrderCancellationPayment,
  type StaffOrderCancellationReasonCode,
} from "./staff-order-cancellation.js";

/**
 * WP-2423 Q6 step 2a: staff cancel whole item lines of a paid, accepted Batch before the kitchen
 * starts them. A kitchen work item is one whole Order line, so a line is cancelled as a whole; a
 * partial quantity of a line is refunded through the ordinary refund instead. The Order and Batch
 * stay active with the remaining lines; the last remaining lines are cancelled through the whole
 * staff cancellation (step 1), which refunds the remaining payment including tip.
 */
export const staffItemCancellationMaximumLines = 100;

const invalid = (): never => {
  throw new StaffOrderCancellationError("STAFF_ORDER_CANCELLATION_INVALID");
};

export interface StaffItemCancellationLine {
  readonly orderItemReference: string;
  /** The submitted cart line; per-line stock reservations are bound to it. */
  readonly sourceCartLineReference: string;
  readonly quantity: number;
}

/** Facts an item cancellation was prepared from under the Order disposition fence. */
export interface StaffItemCancellationPlan {
  readonly orderType: "Pickup" | "DineIn";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly expectedOrderVersion: number;
  readonly expectedSourceCheckpoint: string;
  /** Selected lines, uuid order. */
  readonly lines: readonly StaffItemCancellationLine[];
  /** Lines of the Batch neither cancelled before nor selected; empty means the whole Batch ends. */
  readonly remainingOrderItemReferences: readonly string[];
  /** Lines an earlier item cancellation of this Batch already cancelled. */
  readonly cancelledOrderItemReferences: readonly string[];
  readonly payment: StaffOrderCancellationPayment;
}

export interface StaffItemCancellationRecord {
  readonly cancellationReference: string;
  readonly operationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly expectedOrderVersion: number;
  readonly cancelledOrderVersion: number;
  readonly expectedSourceCheckpoint: string;
  readonly actorReference: string;
  readonly reasonCode: StaffOrderCancellationReasonCode;
  readonly paymentDispositionReference: string;
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  readonly paymentEventReference: string;
  readonly orderItemReferences: readonly string[];
  readonly kitchenEvidenceDigest: string;
  readonly refundRequestReference: string;
  readonly refundOperationReference: string;
  readonly refundAmountMinor: bigint;
  readonly currencyCode: "CAD";
  readonly sourceDigest: string;
  readonly auditReference: string;
  readonly cancelledAt: string;
}

const recordReferences = [
  "cancellationReference",
  "operationReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "expectedSourceCheckpoint",
  "actorReference",
  "paymentDispositionReference",
  "paymentTransactionReference",
  "paymentIntentReference",
  "paymentAttemptReference",
  "paymentEventReference",
  "refundRequestReference",
  "refundOperationReference",
  "auditReference",
] as const;

function orderType(value: unknown) {
  if (value !== "Pickup" && value !== "DineIn") return invalid();
  return value;
}
function expectedVersion(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2 || value >= 2147483647)
    return invalid();
  return value;
}
/** Distinct references in database uuid order (lowercase canonical text order). */
function references(value: unknown, minimum: number, maximum: number) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return invalid();
  const items = value.map(parseOrderingReference);
  if (items.some((item, index) => index > 0 && item <= (items[index - 1] as string)))
    return invalid();
  return Object.freeze(items);
}
function quantity(value: unknown) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 999)
    return invalid();
  return value;
}

/** Selected order item references: 1..100 distinct, returned in uuid order. */
export function parseStaffItemCancellationSelection(value: unknown): readonly string[] {
  try {
    if (
      !Array.isArray(value) ||
      value.length < 1 ||
      value.length > staffItemCancellationMaximumLines
    )
      return invalid();
    const items = value.map(parseOrderingReference);
    if (new Set(items).size !== items.length) return invalid();
    return Object.freeze([...items].sort());
  } catch {
    return invalid();
  }
}

export function parseStaffItemCancellationPlan(value: unknown): StaffItemCancellationPlan {
  try {
    const raw = readClosedRecord(value, [
      "orderType",
      "orderReference",
      "orderBatchReference",
      "submissionReference",
      "expectedOrderVersion",
      "expectedSourceCheckpoint",
      "lines",
      "remainingOrderItemReferences",
      "cancelledOrderItemReferences",
      "payment",
    ]);
    const payment = readClosedRecord(raw.payment, [
      "dispositionReference",
      "paymentTransactionReference",
      "paymentIntentReference",
      "paymentAttemptReference",
      "paymentEventReference",
    ]);
    if (
      !Array.isArray(raw.lines) ||
      raw.lines.length < 1 ||
      raw.lines.length > staffItemCancellationMaximumLines
    )
      return invalid();
    const lines = raw.lines.map((line: unknown) => {
      const entry = readClosedRecord(line, [
        "orderItemReference",
        "sourceCartLineReference",
        "quantity",
      ]);
      return Object.freeze({
        orderItemReference: parseOrderingReference(entry.orderItemReference),
        sourceCartLineReference: parseOrderingReference(entry.sourceCartLineReference),
        quantity: quantity(entry.quantity),
      });
    });
    const selected = references(
      lines.map((line) => line.orderItemReference),
      1,
      staffItemCancellationMaximumLines,
    );
    const remaining = references(raw.remainingOrderItemReferences, 0, 10000);
    const cancelled = references(raw.cancelledOrderItemReferences, 0, 10000);
    const all = [...selected, ...remaining, ...cancelled];
    if (new Set(all).size !== all.length) return invalid();
    return Object.freeze({
      orderType: orderType(raw.orderType),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      expectedOrderVersion: expectedVersion(raw.expectedOrderVersion),
      expectedSourceCheckpoint: parseOrderingReference(raw.expectedSourceCheckpoint),
      lines: Object.freeze(lines),
      remainingOrderItemReferences: remaining,
      cancelledOrderItemReferences: cancelled,
      payment: Object.freeze({
        dispositionReference: parseOrderingReference(payment.dispositionReference),
        paymentTransactionReference: parseOrderingReference(payment.paymentTransactionReference),
        paymentIntentReference: parseOrderingReference(payment.paymentIntentReference),
        paymentAttemptReference: parseOrderingReference(payment.paymentAttemptReference),
        paymentEventReference: parseOrderingReference(payment.paymentEventReference),
      }),
    });
  } catch {
    return invalid();
  }
}

/** Append-only owner fact. Parsing grants no permission, releases no stock and refunds nothing. */
export function parseStaffItemCancellationRecord(value: unknown): StaffItemCancellationRecord {
  try {
    const raw = readClosedRecord(value, [
      ...recordReferences,
      "orderType",
      "expectedOrderVersion",
      "cancelledOrderVersion",
      "reasonCode",
      "orderItemReferences",
      "kitchenEvidenceDigest",
      "refundAmountMinor",
      "currencyCode",
      "sourceDigest",
      "cancelledAt",
    ]);
    const ids = Object.fromEntries(
      recordReferences.map((key) => [key, parseOrderingReference(raw[key])]),
    ) as unknown as Record<(typeof recordReferences)[number], string>;
    const expected = expectedVersion(raw.expectedOrderVersion);
    const amount =
      typeof raw.refundAmountMinor === "bigint"
        ? raw.refundAmountMinor
        : typeof raw.refundAmountMinor === "string" &&
            /^[1-9][0-9]{0,18}$/u.test(raw.refundAmountMinor)
          ? BigInt(raw.refundAmountMinor)
          : invalid();
    const distinct = [
      ids.cancellationReference,
      ids.operationReference,
      ids.refundRequestReference,
      ids.refundOperationReference,
      ids.auditReference,
    ];
    if (
      raw.cancelledOrderVersion !== expected + 1 ||
      raw.currencyCode !== "CAD" ||
      amount <= 0n ||
      amount > 9223372036854775807n ||
      new Set(distinct).size !== distinct.length ||
      ids.cancellationReference === ids.expectedSourceCheckpoint
    )
      return invalid();
    return Object.freeze({
      ...ids,
      orderType: orderType(raw.orderType),
      expectedOrderVersion: expected,
      cancelledOrderVersion: expected + 1,
      reasonCode: parseStaffOrderCancellationReasonCode(raw.reasonCode),
      orderItemReferences: references(
        raw.orderItemReferences,
        1,
        staffItemCancellationMaximumLines,
      ),
      kitchenEvidenceDigest: parseOrderingHash(raw.kitchenEvidenceDigest),
      refundAmountMinor: amount,
      currencyCode: "CAD" as const,
      sourceDigest: parseOrderingHash(raw.sourceDigest),
      cancelledAt: parseOrderingInstant(raw.cancelledAt),
    });
  } catch {
    return invalid();
  }
}
