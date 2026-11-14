import { ConsumerRegistry, type ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it, vi } from "vitest";
import {
  createOrderCancelledEnvelope,
  createOrderCancelledEventConsumerService,
  parseOrderCancelledEnvelope,
  parseOrderStatusProjection,
  type OrderStatusProjection,
} from "../index.js";

const id = (n: number) => `018f6800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-15T01:46:34.000Z";
const digest = `sha256:${"b".repeat(64)}`;
function event(overrides: Record<string, unknown> = {}) {
  return createOrderCancelledEnvelope({
    eventReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    operationReference: id(4),
    cancelledOrderVersion: 4,
    payload: {
      orderReference: id(5),
      orderBatchReference: id(6),
      cancellationReference: id(7),
      cancellationScope: "Batch",
      reasonCode: "PAYMENT_NOT_STARTED",
      itemCount: 2,
      cancelledAt: at,
      sourceDigest: digest,
      ...overrides,
    },
  });
}
function projection(sourceVersion = 3, orderType = "DineIn"): OrderStatusProjection {
  return parseOrderStatusProjection({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    generationReference: id(20),
    projectedAt: "2026-10-15T01:00:00.000Z",
    freshnessStatus: "Fresh",
    snapshot: {
      sourceVersion,
      sourceCheckpoint: id(21),
      sourceDigest: `sha256:${"a".repeat(64)}`,
      orderReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      guestSessionReference: id(22),
      submissionReference: id(23),
      businessDate: "2026-10-14",
      orderNumber: "7",
      orderType,
      sourceChannel: "Qr",
      canonicalPhase: "Accepted",
      closureStatus: "Open",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Unavailable",
      fulfillmentReference: null,
      fulfillmentCompletionEventReference: null,
      fulfillmentCompletedAt: null,
      eta: null,
      submittedAt: "2026-10-15T00:30:00.000Z",
      batches: [
        {
          orderBatchReference: id(6),
          submittedAt: "2026-10-15T01:00:00.000Z",
          items: [
            {
              orderItemReference: id(24),
              displayName: "Synthetic item",
              quantity: 2,
              lineTotal: { amountMinor: 1200n, currencyCode: "CAD" },
            },
          ],
        },
      ],
    },
  });
}
const tx = {
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
} as unknown as ConsumerTransaction;
function service(current: OrderStatusProjection | null, matches = true) {
  const replace = vi.fn(async (input: { projection: OrderStatusProjection }) => input.projection);
  const consumer = createOrderCancelledEventConsumerService({
    authorization: { authorize: async () => true },
    cancellations: { matches: async () => matches },
    projections: { load: async () => current, replace },
    references: {
      generateGeneration: () => id(30) as never,
      now: () => "2026-10-15T01:47:00.000Z" as never,
    },
  });
  return { consumer, replace };
}
const handle = (consumer: ReturnType<typeof service>["consumer"], envelope = event()) =>
  consumer.registration.handler({ envelope, transaction: tx });

describe("OrderCancelled v1 (WP-2423)", () => {
  it("is an Order event at the cancelled Order version, System actor, no personal data", () => {
    const envelope = event();
    expect(envelope).toMatchObject({
      eventType: "OrderCancelled",
      aggregateType: "Order",
      aggregateId: id(5),
      aggregateVersion: 4n,
      causationId: id(7),
      correlationId: id(4),
      actor: { type: "System" },
      redactionClassification: "indirect_identifier",
    });
    expect(parseOrderCancelledEnvelope(envelope)).toEqual(envelope);
  });
  it.each([
    ["an unknown reason", { reasonCode: "STAFF" }],
    ["no items", { itemCount: 0 }],
    ["a malformed digest", { sourceDigest: "sha256:x" }],
  ])("rejects %s", (_name, overrides) => {
    expect(() => event(overrides)).toThrow("ORDER_CANCELLED_EVENT_INVALID");
  });

  it("advances the status projection's version and checkpoint, keeping phase and rounds", async () => {
    const current = projection();
    const { consumer, replace } = service(current);
    expect(await handle(consumer)).toEqual({ status: "completed", resultHash: "b".repeat(64) });
    const next = replace.mock.calls[0]?.[0].projection;
    expect(next?.snapshot).toEqual({
      ...current.snapshot,
      sourceVersion: 4,
      sourceCheckpoint: id(7),
      sourceDigest: digest,
    });
  });
  it("is a no-op once the projection is at or past the cancellation", async () => {
    const { consumer, replace } = service(projection(5));
    expect((await handle(consumer))?.status).toBe("completed");
    expect(replace).not.toHaveBeenCalled();
  });
  it("retries until the projection exists, and refuses a pickup projection", async () => {
    expect((await handle(service(null).consumer))?.status).toBe("retry_required");
    await expect(handle(service(projection(3, "Pickup")).consumer)).rejects.toThrow();
  });
  it("refuses an event that does not state the stored cancellation", async () => {
    const { consumer, replace } = service(projection(), false);
    await expect(handle(consumer)).rejects.toThrow();
    expect(replace).not.toHaveBeenCalled();
  });
  it("registers beside the other status projection consumers (same name, own event type)", () => {
    const registry = new ConsumerRegistry([service(null).consumer.registration]);
    expect(registry.resolve("ordering.order-status-projection:v1", event())).toHaveProperty(
      "registration",
    );
  });
});
