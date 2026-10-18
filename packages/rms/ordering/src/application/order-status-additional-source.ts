import { parseOrderSubmittedEnvelope } from "./order-submitted-event.js";
import { parseAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import {
  parseOrderStatusSourceSnapshot,
  OrderStatusProjectionError,
} from "../domain/order-status-projection.js";

/** Merge exact owner history, not an arbitrary latest projection. The caller must
 * load the previous revision and additional record on the scoped transaction.
 * Payment/Kitchen facts remain separately owned; submission is not release.
 */
export function createOrderStatusAdditionalSource(input: {
  previous: unknown;
  additional: unknown;
  envelope: unknown;
  locale: string;
  sha256(value: string): string;
}) {
  try {
    const previous = parseOrderStatusSourceSnapshot(input.previous);
    const additional = parseAdditionalDiningBatchSnapshot(input.additional);
    const event = parseOrderSubmittedEnvelope(input.envelope);
    const batch = additional.batch;
    if (
      previous.sourceVersion !== additional.expectedOrderVersion ||
      previous.orderReference !== additional.orderReference ||
      previous.brandReference !== additional.brandReference ||
      previous.storeReference !== additional.storeReference ||
      previous.orderType !== "DineIn" ||
      previous.submittedAt !== additional.originalOrderCreatedAt ||
      previous.batches.length + 1 !== additional.batchSequence ||
      event.aggregateVersion !== BigInt(additional.expectedOrderVersion + 1) ||
      event.aggregateId !== additional.orderReference ||
      event.tenantId !== additional.brandReference ||
      event.storeId !== additional.storeReference ||
      event.occurredAt !== batch.submittedAt ||
      event.payload.orderBatchReference !== batch.orderBatchReference ||
      event.payload.submissionReference !== batch.submissionReference ||
      event.payload.batchSequence !== additional.batchSequence ||
      event.payload.itemCount !== additional.items.length ||
      event.payload.sourceSnapshotDigest !==
        input.sha256(encodeAdditionalDiningBatchSnapshot(additional))
    )
      throw new Error();
    return parseOrderStatusSourceSnapshot({
      ...previous,
      // DEC-PILOT-BATCH-PHASE-01: a new Submitted Batch does not erase
      // existing accepted/started work. All previously terminal items are
      // excluded from remaining progress; cancellation authority stays in
      // immutable owner history, never in this presentation phase.
      canonicalPhase:
        previous.canonicalPhase === "Accepted"
          ? "Accepted"
          : ["In Progress", "Ready", "Fulfilled"].includes(previous.canonicalPhase)
            ? "In Progress"
            : "Submitted",
      fulfillmentStatus: "Unavailable",
      fulfillmentReference: null,
      fulfillmentCompletionEventReference: null,
      fulfillmentCompletedAt: null,
      sourceVersion: Number(event.aggregateVersion),
      sourceCheckpoint: event.eventId,
      sourceDigest: event.payload.sourceSnapshotDigest,
      batches: [
        ...previous.batches,
        {
          orderBatchReference: batch.orderBatchReference,
          submittedAt: batch.submittedAt,
          items: additional.items.map((item) => ({
            orderItemReference: item.orderItemReference,
            displayName: item.catalog.localizedNames[input.locale],
            quantity: item.quantity,
            lineTotal: item.pricing.total,
          })),
        },
      ],
    });
  } catch {
    throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
  }
}
