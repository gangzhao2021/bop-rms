import type { ConsumerTransaction } from "@bop/eventing";
import { describe, expect, it } from "vitest";

import {
  createOrderCreatedEventConsumerService,
  parseOrderCreatedEnvelope,
  type OrderCreatedEventConsumerPorts,
  type OrderStatusProjection,
} from "../index.js";

const id = (n: number) => `018f6500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-03T14:00:00.000Z";
const digest = `sha256:${"b".repeat(64)}`;
const refs = {
  event: id(1),
  brand: id(2),
  store: id(3),
  order: id(4),
  correlation: id(5),
  submission: id(6),
  batch: id(7),
  guest: id(8),
  item: id(9),
  generation: id(10),
};

function envelope() {
  return parseOrderCreatedEnvelope({
    eventId: refs.event,
    eventType: "OrderCreated",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/ordering",
    tenantId: refs.brand,
    storeId: refs.store,
    aggregateType: "Order",
    aggregateId: refs.order,
    aggregateVersion: 1n,
    correlationId: refs.correlation,
    causationId: refs.submission,
    actor: { type: "System" },
    payload: {
      orderReference: refs.order,
      orderBatchReference: refs.batch,
      submissionReference: refs.submission,
      businessDate: "2026-08-03",
      sourceSnapshotDigest: digest,
      itemCount: 1,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceVersion: 1,
    sourceCheckpoint: refs.event,
    sourceDigest: digest,
    orderReference: refs.order,
    brandReference: refs.brand,
    storeReference: refs.store,
    guestSessionReference: refs.guest,
    submissionReference: refs.submission,
    businessDate: "2026-08-03",
    orderNumber: "42",
    orderType: "Pickup",
    sourceChannel: "Qr",
    canonicalPhase: "Submitted",
    closureStatus: "Open",
    paymentStatus: "NotReported",
    kitchenStatus: "Unavailable",
    fulfillmentStatus: "Unavailable",
    eta: null,
    submittedAt: at,
    batches: [
      {
        orderBatchReference: refs.batch,
        submittedAt: at,
        items: [
          {
            orderItemReference: refs.item,
            displayName: "Synthetic item",
            quantity: 1,
            lineTotal: { amountMinor: 1130n, currencyCode: "CAD" },
          },
        ],
      },
    ],
    ...overrides,
  };
}

function transaction() {
  const completed = new Set<string>();
  const value: ConsumerTransaction = {
    async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[]) {
      if (text.startsWith("INSERT INTO platform_eventing.consumer_inbox")) {
        const key = `${values[0]}:${values[1]}`;
        if (completed.has(key)) return { rowCount: 0, rows: [] as Row[] };
        return { rowCount: 1, rows: [{} as Row] };
      }
      if (text.startsWith("SELECT event_type")) {
        return {
          rowCount: 1,
          rows: [
            {
              event_type: "OrderCreated",
              schema_version: 1,
              brand_id: refs.brand,
              store_id: refs.store,
              status: "completed",
            } as Row,
          ],
        };
      }
      if (text.startsWith("UPDATE platform_eventing.consumer_inbox")) {
        completed.add(`${values[0]}:${values[1]}`);
        return { rowCount: 1, rows: [] as Row[] };
      }
      throw new Error("unexpected transaction query");
    },
  };
  return value;
}

function fixture(
  options: {
    current?: OrderStatusProjection | null;
    source?: unknown | null;
  } = {},
) {
  let projection = options.current ?? null;
  let replacements = 0;
  const ports: OrderCreatedEventConsumerPorts = {
    source: {
      async loadExact() {
        return options.source === undefined ? source() : options.source;
      },
    },
    projections: {
      async load() {
        return projection;
      },
      async replace(input) {
        replacements += 1;
        projection = input.projection;
        return input.projection;
      },
    },
    references: {
      generateGeneration: () => refs.generation,
      now: () => at as never,
    },
  };
  return {
    service: createOrderCreatedEventConsumerService(ports),
    projection: () => projection,
    replacements: () => replacements,
  };
}

describe("WP-1226 OrderCreated event", () => {
  it("consumes the exact Store-scoped fact once and replaces the projection transactionally", async () => {
    const state = fixture();
    const tx = transaction();
    await expect(state.service.consume(tx, envelope())).resolves.toEqual({ status: "processed" });
    await expect(state.service.consume(tx, envelope())).resolves.toEqual({
      status: "duplicate_completed",
    });
    expect(state.replacements()).toBe(1);
    expect(state.projection()).toMatchObject({
      projectionName: "ordering_order_status_v1",
      snapshot: {
        sourceCheckpoint: refs.event,
        sourceDigest: digest,
        orderReference: refs.order,
      },
    });
    await expect(
      state.service.consume(tx, {
        ...envelope(),
        payload: { ...envelope().payload, itemCount: 2 },
      }),
    ).rejects.toMatchObject({
      name: "OrderStatusProjectionError",
      code: "ORDER_STATUS_VERSION_CONFLICT",
    });
  });

  it("requests a retry when the exact committed source is not visible yet", async () => {
    const state = fixture({ source: null });
    await expect(state.service.consume(transaction(), envelope())).rejects.toMatchObject({
      name: "ConsumerTransactionRollback",
      outcome: { status: "retry_required", errorCode: "CONSUMER_TEMPORARY_FAILURE" },
    });
    expect(state.replacements()).toBe(0);
  });

  it("fails closed when the source does not match the Event scope or digest", async () => {
    const state = fixture({ source: source({ storeReference: id(20) }) });
    await expect(state.service.consume(transaction(), envelope())).rejects.toMatchObject({
      name: "OrderStatusProjectionError",
      code: "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
    });
    expect(state.replacements()).toBe(0);
  });

  it("rejects a conflicting same-version Event instead of silently replacing content", async () => {
    const first = fixture();
    await first.service.consume(transaction(), envelope());
    const current = first.projection();
    if (current === null) throw new Error("projection missing");
    const conflict = fixture({
      current: {
        ...current,
        snapshot: { ...current.snapshot, sourceCheckpoint: id(30) as never },
      },
    });
    await expect(conflict.service.consume(transaction(), envelope())).rejects.toMatchObject({
      name: "OrderStatusProjectionError",
      code: "ORDER_STATUS_VERSION_CONFLICT",
    });
  });

  it("never treats a projection from another Store as an idempotent replay", async () => {
    const first = fixture();
    await first.service.consume(transaction(), envelope());
    const current = first.projection();
    if (current === null) throw new Error("projection missing");
    const otherStore = fixture({
      current: {
        ...current,
        snapshot: { ...current.snapshot, storeReference: id(40) as never },
      },
    });
    await expect(otherStore.service.consume(transaction(), envelope())).rejects.toMatchObject({
      name: "OrderStatusProjectionError",
      code: "ORDER_STATUS_VERSION_CONFLICT",
    });
    expect(otherStore.replacements()).toBe(0);
  });
});
