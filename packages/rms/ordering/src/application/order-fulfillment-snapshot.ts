import {
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
} from "../domain/order-creation.js";
import { parseOrderingHash } from "../domain/cart.js";
import { parseOrderConfirmedEnvelope } from "./order-confirmed-event.js";
import { orderCreatedSourceInput } from "./order-created-source.js";
import { OrderFulfillmentSourceError } from "../contracts/order-fulfillment-source.js";
import {
  parseConfirmedOrderFulfillmentSourceEvidence,
  createOrderFulfillmentSourceLineBinding,
  createOrderFulfillmentSourceEvidenceBinding,
} from "./order-fulfillment-source.js";

/** Original immutable transaction snapshots only; caller proves persisted confirmation and current access. */
export function createOrderFulfillmentSourceFromSnapshot(input: {
  order: unknown;
  quoteVersion: 1 | 2;
  confirmationEvent: unknown;
  sha256(value: string): string;
}) {
  try {
    const order =
      input.quoteVersion === 2
        ? parseConfiguredOrderCreationRecord(input.order)
        : input.quoteVersion === 1
          ? parseOrderCreationRecord(input.order)
          : unavailable();
    const event = parseOrderConfirmedEnvelope(input.confirmationEvent);
    const batch = order.order.batches.find(
      (entry) => entry.orderBatchReference === event.payload.orderBatchReference,
    );
    const hash = (value: string) => parseOrderingHash(input.sha256(value));
    if (
      !batch ||
      event.tenantId !== order.order.brandReference ||
      event.storeId !== order.order.storeReference ||
      event.payload.orderReference !== order.order.orderReference ||
      order.createdAt > event.occurredAt ||
      hash(orderCreatedSourceInput(order, order.orderNumberAllocation.businessDateResolution)) !==
        event.payload.sourceSnapshotDigest
    )
      return unavailable();
    const items = order.items
      .filter((entry) => entry.orderBatchReference === batch.orderBatchReference)
      .map((entry, index) => {
        const line = {
          orderItemReference: entry.orderItemReference,
          ordinal: index + 1,
          quantity: entry.quantity,
          lineDigest: "sha256:" + "0".repeat(64),
        };
        return { ...line, lineDigest: hash(createOrderFulfillmentSourceLineBinding(line)) };
      });
    if (items.length !== batch.items.length) return unavailable();
    const source = parseConfirmedOrderFulfillmentSourceEvidence({
      evidenceReference: order.submissionReference,
      brandReference: order.order.brandReference,
      storeReference: order.order.storeReference,
      orderReference: order.order.orderReference,
      orderBatchReference: batch.orderBatchReference,
      confirmationReference: event.payload.confirmationReference,
      sourceEventReference: event.eventId,
      sourceAggregateVersion: event.aggregateVersion,
      sourceSnapshotDigest: event.payload.sourceSnapshotDigest,
      orderType: order.order.orderType,
      capturedAt: order.createdAt,
      evidenceVersion: 1,
      items,
      evidenceDigest: "sha256:" + "0".repeat(64),
    });
    return parseConfirmedOrderFulfillmentSourceEvidence({
      ...source,
      evidenceDigest: hash(createOrderFulfillmentSourceEvidenceBinding(source)),
    });
  } catch {
    return unavailable();
  }
}
function unavailable(): never {
  throw new OrderFulfillmentSourceError("ORDER_FULFILLMENT_SOURCE_DEPENDENCY_UNAVAILABLE");
}
