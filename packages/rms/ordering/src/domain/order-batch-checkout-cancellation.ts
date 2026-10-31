import { readClosedRecord } from "@bop/identity";
import { parseOrderingReference, parseOrderingInstant, parseOrderingHash } from "./cart.js";
import { parseOrderBatchCheckoutExpiry } from "./order-batch-checkout-expiry.js";
import { summarizeOrderItemProgress, type OrderItemProgressFact } from "./order-item-progress.js";
const fail = (): never => {
  throw new Error("ORDER_BATCH_CHECKOUT_CANCELLATION_INVALID");
};
const references = [
  "cancellationReference",
  "operationReference",
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "paymentOperationReference",
  "expectedSourceCheckpoint",
  "workflowVersionReference",
  "transitionReference",
] as const;
/**
 * Why an unpaid round was cancelled. When its payment window ended (System):
 * CHECKOUT_DEADLINE_REACHED — its payment failed; PAYMENT_NOT_STARTED — no payment was ever
 * started for it (WP-2423: a staff-entered round not paid on the card machine, or a guest round whose
 * online payment never began); PAYMENT_NOT_COMPLETED — the guest started paying online and never
 * finished, so Payment cancelled that attempt at the Provider (WP-2423 abandoned payment).
 * Before the deadline: STAFF_CANCELLED_UNPAID — a manager cancelled the unpaid round (no expiry
 * evidence exists yet). Nothing was charged in any case.
 */
export const orderBatchCheckoutCancellationReasonCodes = [
  "CHECKOUT_DEADLINE_REACHED",
  "PAYMENT_NOT_STARTED",
  "PAYMENT_NOT_COMPLETED",
  "STAFF_CANCELLED_UNPAID",
] as const;
export type OrderBatchCheckoutCancellationReasonCode =
  (typeof orderBatchCheckoutCancellationReasonCodes)[number];
/** Append-only owner fact. Parsing grants no permission and releases no stock.
 * The writer must re-resolve source evidence and complete membership under fences.
 */
export function parseOrderBatchCheckoutCancellation(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      ...references,
      "expiryRecordReference",
      "expiryEvidenceDigest",
      "expectedOrderVersion",
      "cancelledOrderVersion",
      "orderItemReferences",
      "cancelledAt",
      "phase",
      "reasonCode",
    ]);
    const ids = Object.fromEntries(
      references.map((key) => [key, parseOrderingReference(raw[key])]),
    ) as Record<(typeof references)[number], ReturnType<typeof parseOrderingReference>>;
    const expected = raw.expectedOrderVersion,
      next = raw.cancelledOrderVersion;
    if (
      typeof expected !== "number" ||
      !Number.isInteger(expected) ||
      expected < 1 ||
      expected >= 2147483647 ||
      next !== expected + 1 ||
      raw.phase !== "Cancelled" ||
      !(orderBatchCheckoutCancellationReasonCodes as readonly unknown[]).includes(raw.reasonCode) ||
      // Staff cancel before the deadline, so only that reason has no expiry evidence.
      (raw.reasonCode === "STAFF_CANCELLED_UNPAID") !== (raw.expiryRecordReference === null) ||
      (raw.expiryRecordReference === null) !== (raw.expiryEvidenceDigest === null) ||
      !Array.isArray(raw.orderItemReferences) ||
      raw.orderItemReferences.length === 0
    )
      return fail();
    const items = raw.orderItemReferences.map(parseOrderingReference);
    if (
      new Set(items).size !== items.length ||
      items.some((item, index) => index > 0 && item <= (items[index - 1] ?? item))
    )
      return fail();
    return Object.freeze({
      ...ids,
      expiryRecordReference:
        raw.expiryRecordReference === null
          ? null
          : parseOrderingReference(raw.expiryRecordReference),
      expiryEvidenceDigest:
        raw.expiryEvidenceDigest === null ? null : parseOrderingHash(raw.expiryEvidenceDigest),
      expectedOrderVersion: expected,
      cancelledOrderVersion: next,
      orderItemReferences: Object.freeze(items),
      cancelledAt: parseOrderingInstant(raw.cancelledAt),
      phase: "Cancelled" as const,
      reasonCode: raw.reasonCode as OrderBatchCheckoutCancellationReasonCode,
    });
  } catch {
    return fail();
  }
}
export type OrderBatchCheckoutCancellation = ReturnType<typeof parseOrderBatchCheckoutCancellation>;

/** Caller supplies all current scoped items and a currently authorized workflow.
 * Financial finality alone never permits cancelling accepted or produced items.
 */
export function createOrderBatchCheckoutCancellation(input: {
  record: unknown;
  /** The round's latest expiry evidence; null only for a staff cancellation before the deadline. */
  expiry: unknown;
  items: readonly (OrderItemProgressFact & { readonly orderBatchReference: string })[];
}) {
  try {
    const record = parseOrderBatchCheckoutCancellation(input.record);
    // A staff cancellation before the deadline has no expiry evidence; the writer's source proves
    // the round, its submission and payment operation from Ordering's own records instead.
    if (record.reasonCode === "STAFF_CANCELLED_UNPAID") {
      if (input.expiry !== null) return fail();
      return resolveItems(record, input.items);
    }
    const expiry = parseOrderBatchCheckoutExpiry(input.expiry);
    for (const key of [
      "tenantReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "orderBatchReference",
      "submissionReference",
      "paymentOperationReference",
    ] as const)
      if (record[key] !== expiry[key]) return fail();
    // The reason follows the expiry evidence: a failed payment, or none recorded at the deadline
    // (the caller proves from Payment that none was ever started before it uses the latter).
    if (
      (record.reasonCode === "CHECKOUT_DEADLINE_REACHED" ||
      record.reasonCode === "PAYMENT_NOT_COMPLETED"
        ? expiry.status !== "PaymentFailed"
        : expiry.status !== "AwaitingPaymentResolution") ||
      record.expiryRecordReference !== expiry.recordReference ||
      record.expiryEvidenceDigest !== expiry.evidenceDigest ||
      record.cancelledAt < expiry.observedAt
    )
      return fail();
    return resolveItems(record, input.items);
  } catch {
    return fail();
  }
}
function resolveItems(
  record: OrderBatchCheckoutCancellation,
  inputItems: readonly (OrderItemProgressFact & { readonly orderBatchReference: string })[],
) {
  try {
    const input = { items: inputItems };
    summarizeOrderItemProgress(input.items);
    const target = input.items.filter(
      (item) => parseOrderingReference(item.orderBatchReference) === record.orderBatchReference,
    );
    if (
      target.length !== record.orderItemReferences.length ||
      target.some((item) => item.phase !== "Submitted" || item.everAccepted || item.everStarted)
    )
      return fail();
    const members = target.map((item) => parseOrderingReference(item.orderItemReference)).sort();
    if (members.some((item, index) => item !== record.orderItemReferences[index])) return fail();
    const items = input.items.map((item) =>
      Object.freeze({
        ...item,
        ...(item.orderBatchReference === record.orderBatchReference
          ? { phase: "Cancelled" as const }
          : {}),
      }),
    );
    return Object.freeze({
      record,
      items: Object.freeze(items),
      progress: summarizeOrderItemProgress(items),
    });
  } catch {
    return fail();
  }
}
