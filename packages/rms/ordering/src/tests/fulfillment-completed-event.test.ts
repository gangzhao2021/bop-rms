import type { ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it } from "vitest";
import {
  createFulfillmentCompletedEventConsumerService,
  parseFulfillmentCompletedEnvelope,
  parseOrderStatusProjection,
  type FulfillmentCompletedEventConsumerPorts,
  type OrderStatusProjection,
} from "../index.js";

const id = (n: number) => `018f6800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-11T15:00:00.000Z";
const refs = {
  event: id(1),
  brand: id(2),
  store: id(3),
  fulfillment: id(4),
  order: id(5),
  handoff: id(6),
  correlation: id(7),
  causation: id(8),
  generation: id(9),
  checkpoint: id(10),
  guest: id(11),
  submission: id(12),
  batch: id(13),
  item: id(14),
};

function event(overrides: Record<string, unknown> = {}) {
  return parseFulfillmentCompletedEnvelope({
    eventId: refs.event,
    eventType: "FulfillmentCompleted",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/fulfillment",
    tenantId: refs.brand,
    storeId: refs.store,
    aggregateType: "Fulfillment",
    aggregateId: refs.fulfillment,
    aggregateVersion: 5n,
    correlationId: refs.correlation,
    causationId: refs.causation,
    actor: { type: "System" },
    payload: {
      fulfillmentReference: refs.fulfillment,
      orderReference: refs.order,
      handoffRecordReference: refs.handoff,
      storeReference: refs.store,
      verificationMethod: "Opaque",
      completedAt: at,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
    ...overrides,
  });
}
function projection(overrides: Record<string, unknown> = {}) {
  return parseOrderStatusProjection({
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    generationReference: refs.generation,
    projectedAt: "2026-08-11T14:00:00.000Z",
    freshnessStatus: "Fresh",
    snapshot: {
      sourceVersion: 1,
      sourceCheckpoint: refs.checkpoint,
      sourceDigest: `sha256:${"a".repeat(64)}`,
      orderReference: refs.order,
      brandReference: refs.brand,
      storeReference: refs.store,
      guestSessionReference: refs.guest,
      submissionReference: refs.submission,
      businessDate: "2026-08-11",
      orderNumber: "42",
      orderType: "Pickup",
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
      submittedAt: "2026-08-11T14:00:00.000Z",
      batches: [
        {
          orderBatchReference: refs.batch,
          submittedAt: "2026-08-11T14:00:00.000Z",
          items: [
            {
              orderItemReference: refs.item,
              displayName: "Synthetic item",
              quantity: 1,
              lineTotal: { amountMinor: 1200n, currencyCode: "CAD" },
            },
          ],
        },
      ],
      ...overrides,
    },
  });
}
function transaction(): ConsumerTransaction {
  const completed = new Set<string>();
  return {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[]) {
      if (text.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
        const key = `${values[0]}:${values[1]}`;
        if (completed.has(key)) return { rowCount: 0, rows: [] as Row[] };
        return { rowCount: 1, rows: [{} as Row] };
      }
      if (text.startsWith("SELECT event_type"))
        return {
          rowCount: 1,
          rows: [
            {
              event_type: "FulfillmentCompleted",
              schema_version: 1,
              brand_id: refs.brand,
              store_id: refs.store,
              status: "completed",
            } as Row,
          ],
        };
      if (text.startsWith("UPDATE platform_eventing.consumer_inbox")) {
        completed.add(`${values[0]}:${values[1]}`);
        return { rowCount: 1, rows: [] as Row[] };
      }
      throw new Error("unexpected query");
    },
  };
}
function fixture(current: OrderStatusProjection | null = projection()) {
  let value = current;
  let replacements = 0;
  const ports: FulfillmentCompletedEventConsumerPorts = {
    projections: {
      load: async () => value,
      replace: async (input) => {
        replacements += 1;
        value = input.projection;
        return input.projection;
      },
    },
    references: { generateGeneration: () => id(20) as never, now: () => at as never },
    digests: { sha256: () => `sha256:${"b".repeat(64)}` },
  };
  return {
    service: createFulfillmentCompletedEventConsumerService(ports),
    current: () => value,
    replacements: () => replacements,
  };
}

describe("WP-1605 FulfillmentCompleted projection", () => {
  it("advances Pickup to Fulfilled + Open exactly once", async () => {
    const state = fixture();
    const tx = transaction();
    await expect(state.service.consume(tx, event())).resolves.toEqual({ status: "processed" });
    await expect(state.service.consume(tx, event())).resolves.toEqual({
      status: "duplicate_completed",
    });
    expect(state.replacements()).toBe(1);
    expect(state.current()).toMatchObject({
      snapshot: {
        canonicalPhase: "Fulfilled",
        closureStatus: "Open",
        fulfillmentStatus: "Completed",
        fulfillmentReference: refs.fulfillment,
        fulfillmentCompletionEventReference: refs.event,
        fulfillmentCompletedAt: at,
      },
    });
  });
  it("requests retry before the Order projection exists", async () => {
    await expect(fixture(null).service.consume(transaction(), event())).rejects.toMatchObject({
      name: "ConsumerTransactionRollback",
      outcome: { status: "retry_required" },
    });
  });
  it("rejects cross-Store, non-Pickup and conflicting completion facts", async () => {
    await expect(
      fixture(projection({ storeReference: id(30) })).service.consume(transaction(), event()),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_VERSION_CONFLICT" });
    await expect(
      fixture(projection({ orderType: "DineIn" })).service.consume(transaction(), event()),
    ).rejects.toMatchObject({ code: "ORDER_STATUS_VERSION_CONFLICT" });
    const completed = projection({
      canonicalPhase: "Fulfilled",
      fulfillmentStatus: "Completed",
      fulfillmentReference: id(40),
      fulfillmentCompletionEventReference: id(41),
      fulfillmentCompletedAt: at,
    });
    await expect(fixture(completed).service.consume(transaction(), event())).rejects.toMatchObject({
      code: "ORDER_STATUS_VERSION_CONFLICT",
    });
  });
  it("rejects extra payload data and mismatched Event scope", () => {
    expect(() => event({ payload: { ...event().payload, customerName: "forbidden" } })).toThrow();
    expect(() => event({ storeId: id(50) })).toThrow();
  });
});
