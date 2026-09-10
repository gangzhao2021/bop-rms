import type { StoreBusinessDateResolution } from "@rms/store";
import type { OrderCreationRecord } from "../domain/order-creation.js";

export function orderCreatedSourceInput(
  record: Omit<OrderCreationRecord, "orderNumberAllocation">,
  resolution: StoreBusinessDateResolution,
): string {
  const order = record.order;
  const batch = order.batches[0];
  return `OrderCreatedSource:v1:${JSON.stringify({
    orderReference: order.orderReference,
    brandReference: order.brandReference,
    storeReference: order.storeReference,
    submissionReference: record.submissionReference,
    orderBatchReference: batch.orderBatchReference,
    orderType: order.orderType,
    sourceChannel: order.sourceChannel,
    aggregateVersion: order.aggregateVersion,
    createdAt: record.createdAt,
    businessDate: resolution.businessDate,
    items: record.items.map((item) => ({
      orderItemReference: item.orderItemReference,
      catalogSnapshotDigest: item.catalog.snapshotDigest,
      quoteInputDigest: item.pricing.quoteInputDigest,
      quantity: item.quantity,
      totalAmountMinor: item.pricing.total.amountMinor.toString(),
      currencyCode: item.pricing.total.currencyCode,
    })),
  })}`;
}
