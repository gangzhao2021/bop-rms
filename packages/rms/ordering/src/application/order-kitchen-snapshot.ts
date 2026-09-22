import { parseAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
import {
  parseOrderCreationRecord,
  parseConfiguredOrderCreationRecord,
} from "../domain/order-creation.js";
import { parseOrderingHash } from "../domain/cart.js";
import { parseOrderConfirmedEnvelope } from "./order-confirmed-event.js";
import { orderCreatedSourceInput } from "./order-created-source.js";
import { OrderKitchenSourceError } from "../contracts/order-kitchen-source.js";
import {
  parseConfirmedOrderKitchenSourceEvidence,
  createOrderKitchenSourceLineBinding,
  createOrderKitchenSourceEvidenceBinding,
} from "./order-kitchen-source.js";

/** Original immutable transaction snapshots only; caller proves persisted confirmation and current access. */
export function createOrderKitchenSourceFromSnapshot(input: {
  order: unknown;
  submissionKind?: "Additional";
  quoteVersion: 1 | 2;
  confirmationEvent: unknown;
  sha256(value: string): string;
}) {
  try {
    if (input.submissionKind !== undefined && input.submissionKind !== "Additional")
      return unavailable();
    const additional =
      input.submissionKind === "Additional"
        ? parseAdditionalDiningBatchSnapshot(input.order)
        : null;
    if (additional && additional.snapshotVersion !== input.quoteVersion) return unavailable();
    const order = additional
      ? null
      : input.quoteVersion === 2
        ? parseConfiguredOrderCreationRecord(input.order)
        : input.quoteVersion === 1
          ? parseOrderCreationRecord(input.order)
          : unavailable();
    const event = parseOrderConfirmedEnvelope(input.confirmationEvent);
    const batch =
      additional?.batch ??
      order?.order.batches.find(
        (entry) => entry.orderBatchReference === event.payload.orderBatchReference,
      );
    const brand = additional?.brandReference ?? order?.order.brandReference;
    const store = additional?.storeReference ?? order?.order.storeReference;
    const orderReference = additional?.orderReference ?? order?.order.orderReference;
    const submittedAt = additional?.batch.submittedAt ?? order?.createdAt;
    const submission = additional?.batch.submissionReference ?? order?.submissionReference;
    const originalItems = additional?.items ?? order?.items;
    if (!brand || !store || !orderReference || !submittedAt || !submission || !originalItems)
      return unavailable();
    const hash = (value: string) => parseOrderingHash(input.sha256(value));
    if (
      !batch ||
      batch.orderBatchReference !== event.payload.orderBatchReference ||
      event.tenantId !== brand ||
      event.storeId !== store ||
      event.payload.orderReference !== orderReference ||
      submittedAt > event.occurredAt ||
      hash(
        additional
          ? encodeAdditionalDiningBatchSnapshot(additional)
          : order
            ? orderCreatedSourceInput(order, order.orderNumberAllocation.businessDateResolution)
            : unavailable(),
      ) !== event.payload.sourceSnapshotDigest
    )
      return unavailable();
    const items = originalItems
      .filter((entry) => entry.orderBatchReference === batch.orderBatchReference)
      .map((entry, index) => {
        const line = {
          orderItemReference: entry.orderItemReference,
          orderBatchReference: batch.orderBatchReference,
          ordinal: index + 1,
          quantity: entry.quantity,
          productReference: entry.catalog.productReference,
          productVersionReference: entry.catalog.productVersionReference,
          skuReference: entry.catalog.skuReference,
          menuVersionReference: entry.catalog.menuVersionReference,
          localizedDisplayNames: entry.catalog.localizedNames,
          selectedOptions: entry.catalog.options.map((option) => ({
            optionReference: option.optionReference,
            quantity: option.quantity,
            localizedNames: option.localizedNames,
          })),
          customerNote: entry.customerNote,
          lineDigest: "sha256:" + "0".repeat(64),
        };
        return { ...line, lineDigest: hash(createOrderKitchenSourceLineBinding(line)) };
      });
    if (items.length !== batch.items.length) return unavailable();
    const source = parseConfirmedOrderKitchenSourceEvidence({
      evidenceReference: submission,
      brandReference: brand,
      storeReference: store,
      orderReference,
      orderBatchReference: batch.orderBatchReference,
      confirmationReference: event.payload.confirmationReference,
      sourceEventReference: event.eventId,
      sourceAggregateVersion: event.aggregateVersion,
      sourceSnapshotDigest: event.payload.sourceSnapshotDigest,
      capturedAt: submittedAt,
      evidenceVersion: 1,
      items,
      evidenceDigest: "sha256:" + "0".repeat(64),
    });
    return parseConfirmedOrderKitchenSourceEvidence({
      ...source,
      evidenceDigest: hash(createOrderKitchenSourceEvidenceBinding(source)),
    });
  } catch {
    return unavailable();
  }
}
function unavailable(): never {
  throw new OrderKitchenSourceError("ORDER_KITCHEN_SOURCE_DEPENDENCY_UNAVAILABLE");
}
