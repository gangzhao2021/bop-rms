import { readClosedRecord } from "@bop/identity";
import type { PaidWithoutFulfillableOrderDisposition } from "../contracts/order-payment-outcome.js";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import { parseOrderPaymentOutcomeDisposition } from "./order-payment-outcome.js";

/** WP-2423 Q6: why store staff cancelled a paid, accepted Batch before the kitchen started it. */
export const staffOrderCancellationReasonCodes = [
  "CUSTOMER_REQUEST",
  "SOLD_OUT",
  "STORE_ERROR",
  "DUPLICATE_ORDER",
] as const;
export type StaffOrderCancellationReasonCode = (typeof staffOrderCancellationReasonCodes)[number];

/**
 * Code-owned staff cancellation policy. Staff may cancel only before preparation starts (the
 * irreversible point) and Payment always refunds the whole remaining capture, so this is a fixed
 * transition, not a Store-configurable workflow; the references identify this policy version in the
 * pickup termination history.
 */
export const staffOrderCancellationPolicy = Object.freeze({
  purposeCode: "StaffOrderCancellation",
  permissionCode: "ordering.order.cancel",
  workflowVersionReference: "019a0c00-2423-7061-8000-000000000001",
  transitionReference: "019a0c00-2423-7061-8000-000000000002",
} as const);

export class StaffOrderCancellationError extends Error {
  constructor(
    readonly code:
      | "STAFF_ORDER_CANCELLATION_INVALID"
      | "STAFF_ORDER_CANCELLATION_CONFLICT"
      | "STAFF_ORDER_CANCELLATION_UNAVAILABLE",
  ) {
    super("staff order cancellation is unavailable");
    this.name = "StaffOrderCancellationError";
  }
}
const invalid = (): never => {
  throw new StaffOrderCancellationError("STAFF_ORDER_CANCELLATION_INVALID");
};

export interface StaffOrderCancellationPayment {
  readonly dispositionReference: string;
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  readonly paymentEventReference: string;
}

/** Facts a staff cancellation was prepared from under the Order disposition fence. */
export interface StaffOrderCancellationPlan {
  readonly orderType: "Pickup" | "DineIn";
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly submissionReference: string;
  readonly expectedOrderVersion: number;
  readonly expectedSourceCheckpoint: string;
  readonly orderItemReferences: readonly string[];
  readonly payment: StaffOrderCancellationPayment;
}

export interface StaffOrderCancellationRecord {
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
  "auditReference",
] as const;

function orderType(value: unknown) {
  if (value !== "Pickup" && value !== "DineIn") return invalid();
  return value;
}
function expectedVersion(value: unknown) {
  // Version 1 is the submitted Order; a cancellable Batch is at least accepted.
  if (typeof value !== "number" || !Number.isInteger(value) || value < 2 || value >= 2147483647)
    return invalid();
  return value;
}
/** Complete Batch membership in database uuid order (lowercase canonical text order). */
function itemReferences(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 10000) return invalid();
  const items = value.map(parseOrderingReference);
  if (items.some((item, index) => index > 0 && item <= (items[index - 1] as string)))
    return invalid();
  return Object.freeze(items);
}

export function parseStaffOrderCancellationReasonCode(
  value: unknown,
): StaffOrderCancellationReasonCode {
  if (!staffOrderCancellationReasonCodes.includes(value as never)) return invalid();
  return value as StaffOrderCancellationReasonCode;
}

export function parseStaffOrderCancellationPlan(value: unknown): StaffOrderCancellationPlan {
  try {
    const raw = readClosedRecord(value, [
      "orderType",
      "orderReference",
      "orderBatchReference",
      "submissionReference",
      "expectedOrderVersion",
      "expectedSourceCheckpoint",
      "orderItemReferences",
      "payment",
    ]);
    const payment = readClosedRecord(raw.payment, [
      "dispositionReference",
      "paymentTransactionReference",
      "paymentIntentReference",
      "paymentAttemptReference",
      "paymentEventReference",
    ]);
    return Object.freeze({
      orderType: orderType(raw.orderType),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      expectedOrderVersion: expectedVersion(raw.expectedOrderVersion),
      expectedSourceCheckpoint: parseOrderingReference(raw.expectedSourceCheckpoint),
      orderItemReferences: itemReferences(raw.orderItemReferences),
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
export function parseStaffOrderCancellationRecord(value: unknown): StaffOrderCancellationRecord {
  try {
    const raw = readClosedRecord(value, [
      ...recordReferences,
      "orderType",
      "expectedOrderVersion",
      "cancelledOrderVersion",
      "reasonCode",
      "orderItemReferences",
      "kitchenEvidenceDigest",
      "sourceDigest",
      "cancelledAt",
    ]);
    const ids = Object.fromEntries(
      recordReferences.map((key) => [key, parseOrderingReference(raw[key])]),
    ) as unknown as Record<(typeof recordReferences)[number], string>;
    const expected = expectedVersion(raw.expectedOrderVersion);
    if (
      raw.cancelledOrderVersion !== expected + 1 ||
      ids.cancellationReference === ids.expectedSourceCheckpoint
    )
      return invalid();
    return Object.freeze({
      ...ids,
      orderType: orderType(raw.orderType),
      expectedOrderVersion: expected,
      cancelledOrderVersion: expected + 1,
      reasonCode: parseStaffOrderCancellationReasonCode(raw.reasonCode),
      orderItemReferences: itemReferences(raw.orderItemReferences),
      kitchenEvidenceDigest: parseOrderingHash(raw.kitchenEvidenceDigest),
      sourceDigest: parseOrderingHash(raw.sourceDigest),
      cancelledAt: parseOrderingInstant(raw.cancelledAt),
    });
  } catch {
    return invalid();
  }
}

/**
 * The compensation source view Payment refunds from: the paid Batch can no longer be fulfilled
 * because staff cancelled it (kitchen release Blocked; the kitchen work was cancelled by Kitchen).
 * The disposition reference is the staff cancellation reference, never a disposition row.
 */
export function staffOrderCancellationDisposition(
  record: StaffOrderCancellationRecord,
): PaidWithoutFulfillableOrderDisposition {
  const saved = parseStaffOrderCancellationRecord(record);
  return parseOrderPaymentOutcomeDisposition({
    dispositionReference: saved.cancellationReference,
    brandReference: saved.brandReference,
    storeReference: saved.storeReference,
    orderReference: saved.orderReference,
    orderBatchReference: saved.orderBatchReference,
    submissionReference: saved.submissionReference,
    paymentTransactionReference: saved.paymentTransactionReference,
    paymentIntentReference: saved.paymentIntentReference,
    paymentAttemptReference: saved.paymentAttemptReference,
    paymentEventReference: saved.paymentEventReference,
    sourceVersion: saved.cancelledOrderVersion,
    sourceCheckpoint: saved.cancellationReference,
    sourceDigest: saved.sourceDigest,
    evaluatedAt: saved.cancelledAt,
    disposition: "PaidWithoutFulfillableOrder",
    reason: "CancelledByStaff",
    kitchenReleaseDisposition: "Blocked",
  }) as PaidWithoutFulfillableOrderDisposition;
}
