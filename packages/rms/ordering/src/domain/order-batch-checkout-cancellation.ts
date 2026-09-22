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
  "expiryRecordReference",
  "expectedSourceCheckpoint",
  "workflowVersionReference",
  "transitionReference",
] as const;
/** Append-only owner fact. Parsing grants no permission and releases no stock.
 * The writer must re-resolve source evidence and complete membership under fences.
 */
export function parseOrderBatchCheckoutCancellation(value: unknown) {
  try {
    const raw = readClosedRecord(value, [
      ...references,
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
      raw.reasonCode !== "CHECKOUT_DEADLINE_REACHED" ||
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
      expiryEvidenceDigest: parseOrderingHash(raw.expiryEvidenceDigest),
      expectedOrderVersion: expected,
      cancelledOrderVersion: next,
      orderItemReferences: Object.freeze(items),
      cancelledAt: parseOrderingInstant(raw.cancelledAt),
      phase: "Cancelled" as const,
      reasonCode: "CHECKOUT_DEADLINE_REACHED" as const,
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
  expiry: unknown;
  items: readonly (OrderItemProgressFact & { readonly orderBatchReference: string })[];
}) {
  try {
    const record = parseOrderBatchCheckoutCancellation(input.record),
      expiry = parseOrderBatchCheckoutExpiry(input.expiry);
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
    if (
      expiry.status !== "PaymentFailed" ||
      record.expiryRecordReference !== expiry.recordReference ||
      record.expiryEvidenceDigest !== expiry.evidenceDigest ||
      record.cancelledAt < expiry.observedAt
    )
      return fail();
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
