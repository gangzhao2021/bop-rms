import { createHash } from "node:crypto";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
import { encodeAdditionalDiningBatchSnapshot } from "../domain/additional-dining-batch-codec.js";
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
const id = (n: number) => "0190ed31-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export function additionalSourceFixture() {
  const f = orderWriteFixture({ dineIn: true });
  const r = f.request.record;
  const firstItem = r.items[0];
  if (!firstItem) throw new Error("synthetic item missing");
  const locale = Object.keys(firstItem.catalog.localizedNames)[0];
  if (!locale) throw new Error("synthetic locale missing");
  const additional = {
    orderReference: r.order.orderReference,
    brandReference: r.order.brandReference,
    storeReference: r.order.storeReference,
    diningSessionReference: r.order.diningSessionReference,
    guestSessionReference: r.guestSessionReference,
    originalOrderCreatedAt: r.createdAt,
    expectedOrderVersion: 2,
    batchSequence: 2,
    snapshotVersion: 1,
    batch: r.order.batches[0],
    items: r.items,
  };
  const previous = {
    sourceVersion: 2,
    sourceCheckpoint: id(91),
    sourceDigest: "sha256:" + "a".repeat(64),
    orderReference: r.order.orderReference,
    brandReference: r.order.brandReference,
    storeReference: r.order.storeReference,
    guestSessionReference: r.guestSessionReference,
    submissionReference: id(92),
    businessDate: f.request.businessDateResolution.businessDate,
    orderNumber: "42",
    orderType: "DineIn",
    sourceChannel: "Qr",
    canonicalPhase: "Submitted",
    closureStatus: "Open",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    fulfillmentReference: null,
    fulfillmentCompletionEventReference: null,
    fulfillmentCompletedAt: null,
    eta: null,
    submittedAt: r.createdAt,
    batches: [
      {
        orderBatchReference: id(93),
        submittedAt: r.createdAt,
        items: [
          {
            orderItemReference: id(94),
            displayName: "Synthetic previous item",
            quantity: 1,
            lineTotal: firstItem.pricing.total,
          },
        ],
      },
    ],
  };
  const envelope = {
    ...f.request.event,
    eventType: "OrderSubmitted",
    aggregateVersion: 3n,
    causationId: additional.batch.submissionReference,
    payload: {
      orderReference: additional.orderReference,
      orderBatchReference: additional.batch.orderBatchReference,
      submissionReference: additional.batch.submissionReference,
      sourceSnapshotDigest: hash(encodeAdditionalDiningBatchSnapshot(additional)),
      itemCount: r.items.length,
      batchSequence: 2,
    },
  };
  return { previous, additional, envelope, locale, sha256: hash };
}
