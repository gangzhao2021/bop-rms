import {
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
} from "../domain/order-creation.js";
import {
  parseOrderStatusSourceSnapshot,
  OrderStatusProjectionError,
} from "../domain/order-status-projection.js";
import { parseOrderCreatedEnvelope } from "./order-created-event.js";
import { orderCreatedSourceInput } from "./order-created-source.js";

/** Original event snapshot; freshness/current phase are resolved separately under owner fences. */
export function createOrderStatusCreationSource(input: {
  record: unknown;
  quoteVersion: 1 | 2;
  envelope: unknown;
  locale: string;
  sha256(value: string): string;
}) {
  const record =
    input.quoteVersion === 2
      ? parseConfiguredOrderCreationRecord(input.record)
      : parseOrderCreationRecord(input.record);
  const event = parseOrderCreatedEnvelope(input.envelope);
  const order = record.order;
  const digest = input.sha256(
    orderCreatedSourceInput(record, record.orderNumberAllocation.businessDateResolution),
  );
  if (
    event.aggregateId !== order.orderReference ||
    event.tenantId !== order.brandReference ||
    event.storeId !== order.storeReference ||
    Number(event.aggregateVersion) !== order.aggregateVersion ||
    event.payload.submissionReference !== record.submissionReference ||
    event.payload.orderBatchReference !== order.batches[0].orderBatchReference ||
    event.payload.businessDate !== record.orderNumberAllocation.businessDate ||
    event.payload.itemCount !== record.items.length ||
    event.occurredAt !== record.createdAt ||
    event.payload.sourceSnapshotDigest !== digest
  )
    throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
  return parseOrderStatusSourceSnapshot({
    sourceVersion: order.aggregateVersion,
    sourceCheckpoint: event.eventId,
    sourceDigest: digest,
    orderReference: order.orderReference,
    brandReference: order.brandReference,
    storeReference: order.storeReference,
    guestSessionReference: record.guestSessionReference,
    submissionReference: record.submissionReference,
    businessDate: record.orderNumberAllocation.businessDate,
    orderNumber: record.orderNumberAllocation.orderNumber,
    orderType: order.orderType,
    sourceChannel: order.sourceChannel,
    canonicalPhase: "Submitted",
    closureStatus: "Open",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    fulfillmentReference: null,
    fulfillmentCompletionEventReference: null,
    fulfillmentCompletedAt: null,
    eta: null,
    submittedAt: record.createdAt,
    batches: order.batches.map((batch) => ({
      orderBatchReference: batch.orderBatchReference,
      submittedAt: batch.submittedAt,
      items: record.items
        .filter((item) => item.orderBatchReference === batch.orderBatchReference)
        .map((item) => ({
          orderItemReference: item.orderItemReference,
          displayName: item.catalog.localizedNames[input.locale],
          quantity: item.quantity,
          lineTotal: item.pricing.total,
        })),
    })),
  });
}
