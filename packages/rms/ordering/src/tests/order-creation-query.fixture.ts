import {
  createOrderAggregate,
  createOrderItemSnapshots,
  createOrderNumberAllocation,
  parseOrderCreationRecord,
  encodeOrderItemSnapshot,
} from "../index.js";
import { resolveStoreBusinessDate } from "@rms/store";
import { orderSnapshotInput } from "./order-item-snapshot.fixture.js";
const id = (n: number) => `018f6400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
export function orderQueryFixture(options: { instantOffsetMs?: number } = {}) {
  const instantOffsetMs = options.instantOffsetMs ?? 0;
  const shiftInstants = (value: unknown): unknown => {
    if (
      typeof value === "string" &&
      instantOffsetMs !== 0 &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
    )
      return new Date(Date.parse(value) + instantOffsetMs).toISOString();
    if (Array.isArray(value)) return value.map(shiftInstants);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, shiftInstants(item)]),
      );
    return value;
  };
  const input = shiftInstants(orderSnapshotInput()) as ReturnType<typeof orderSnapshotInput>;
  const first = createOrderItemSnapshots(input)[0];
  if (!first) throw new Error("fixture");
  const second = {
    ...first,
    orderItemReference: id(1),
    cartItemReference: id(2),
    pricing: { ...first.pricing, lineReference: id(2) },
  };
  const items = [first, second];
  const order = createOrderAggregate({
    orderReference: input.orderReference,
    orderBatchReference: input.orderBatchReference,
    submissionReference: id(3),
    diningSessionReference: null,
    createdByActorReference: input.cart.createdByActorReference,
    submittedByActorReference: input.checkoutValidationEvidence.guestSessionReference,
    submittedAt: input.snapshotCapturedAt,
    checkoutValidationEvidence: {
      ...input.checkoutValidationEvidence,
      catalogLines: [
        ...input.checkoutValidationEvidence.catalogLines,
        {
          ...input.checkoutValidationEvidence.catalogLines[0],
          cartItemReference: second.cartItemReference,
        },
      ],
    },
    items: items.map((i) => ({
      orderItemReference: i.orderItemReference,
      cartItemReference: i.cartItemReference,
    })),
  });
  const resolution = resolveStoreBusinessDate({
    occurredAt: input.snapshotCapturedAt,
    configuration: {
      configurationReference: id(4),
      configurationVersion: 1,
      brandReference: order.brandReference,
      storeReference: order.storeReference,
      timeZone: "America/Toronto",
      businessDayStartLocalTime: "04:00:00",
      businessDayStartSource: "PlatformDefault",
      contentDigest: `sha256:${"a".repeat(64)}`,
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: null,
    },
  });
  const record = parseOrderCreationRecord({
    submissionReference: id(3),
    submissionIntentHash: `sha256:${"b".repeat(64)}`,
    guestSessionReference: order.submittedByActorReference,
    order,
    items,
    orderNumberAllocation: createOrderNumberAllocation({
      orderReference: order.orderReference,
      allocatedAt: order.createdAt,
      sequence: 9007199254740993n,
      businessDateResolution: resolution,
    }),
    createdAt: order.createdAt,
  });
  const history = {
    record: {
      ...record,
      items: [],
      order: { ...record.order, batches: [{ ...record.order.batches[0], items: [] }] },
      orderNumberAllocation: {
        ...record.orderNumberAllocation,
        sequence: record.orderNumberAllocation.sequence.toString(),
      },
    },
    source: {
      cart: order.batches[0].sourceCartReference,
      version: order.batches[0].sourceCartVersion,
      quote: order.batches[0].quoteReference,
      businessDate: record.orderNumberAllocation.businessDate,
      orderNumber: record.orderNumberAllocation.orderNumber,
    },
    items: items.map((item, index) => ({
      ordinal: index + 1,
      orderItemReference: item.orderItemReference,
      orderBatchReference: item.orderBatchReference,
      cartItemReference: item.cartItemReference,
      quantity: item.quantity,
      catalogDigest: item.catalog.snapshotDigest,
      quoteDigest: item.pricing.quoteInputDigest,
      capturedAt: item.snapshotCapturedAt,
      snapshot: JSON.parse(encodeOrderItemSnapshot(item)),
    })),
  };
  return {
    record,
    history,
    scope: { brandReference: order.brandReference, storeReference: order.storeReference },
  };
}
