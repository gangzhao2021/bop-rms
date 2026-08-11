import { describe, expect, it } from "vitest";

import {
  createKitchenReadyEventBundle,
  createKitchenReadyEventSemanticBinding,
  parseKitchenItemReadyEnvelope,
  parseKitchenOrderReadyEnvelope,
  parseKitchenReadyEnvelope,
} from "../application/kitchen-ready-events.js";
import { KitchenReadyEventError } from "../contracts/kitchen-ready-events.js";

function id(value: number): string {
  return `018f5000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
}

const refs = Object.freeze({
  brand: id(1),
  store: id(2),
  ticket: id(3),
  order: id(4),
  batch: id(5),
  item: id(6),
  otherItem: id(7),
  result: id(8),
  otherResult: id(9),
  correlation: id(10),
  causation: id(11),
  itemEvent: id(12),
  orderEvent: id(13),
});

const readyAt = "2026-08-11T15:00:00.000Z";

function input(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    itemEventReference: refs.itemEvent,
    orderEventReference: refs.orderEvent,
    brandReference: refs.brand,
    storeReference: refs.store,
    ticketReference: refs.ticket,
    ticketVersion: 5n,
    orderReference: refs.order,
    orderBatchReference: refs.batch,
    orderItemReference: refs.item,
    readyResultReference: refs.result,
    readyQuantity: 3,
    requiredQuantity: 3,
    readyAt,
    correlationReference: refs.correlation,
    causationReference: refs.causation,
    readiness: [
      {
        orderItemReference: refs.item,
        requiredQuantity: 3,
        readyResultReference: refs.result,
        readyQuantity: 3,
        readyAt,
      },
    ],
    ...overrides,
  };
}

function expectInvalid(operation: () => unknown): void {
  expect(operation).toThrow(
    expect.objectContaining({
      name: "KitchenReadyEventError",
      code: "KITCHEN_READY_EVENT_INVALID",
      message: "kitchen ready event is invalid",
    }),
  );
}

describe("Kitchen Ready public Events", () => {
  it("composes exact Item and whole-Ticket Ready facts", () => {
    const bundle = createKitchenReadyEventBundle(input());
    expect(bundle.itemEvent).toEqual({
      eventId: refs.itemEvent,
      eventType: "KitchenItemReady",
      schemaVersion: 1,
      occurredAt: readyAt,
      producerModule: "@rms/kitchen",
      tenantId: refs.brand,
      storeId: refs.store,
      aggregateType: "KitchenOrderItemReadyResult",
      aggregateId: refs.result,
      aggregateVersion: 1n,
      correlationId: refs.correlation,
      causationId: refs.causation,
      actor: { type: "System" },
      payload: {
        kitchenTicketReference: refs.ticket,
        orderReference: refs.order,
        orderBatchReference: refs.batch,
        orderItemReference: refs.item,
        readyResultReference: refs.result,
        readyQuantity: 3,
        requiredQuantity: 3,
        readyAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
    expect(bundle.orderEvent).toMatchObject({
      eventId: refs.orderEvent,
      eventType: "KitchenOrderReady",
      aggregateType: "KitchenTicket",
      aggregateId: refs.ticket,
      aggregateVersion: 5n,
      payload: { readyItemCount: 1, itemCount: 1, readyAt },
    });
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.itemEvent.payload)).toBe(true);
    expect(Object.isFrozen(bundle.orderEvent?.payload)).toBe(true);
  });

  it("omits Order Ready while another Ticket Item remains unready", () => {
    const bundle = createKitchenReadyEventBundle(
      input({
        orderEventReference: null,
        readiness: [
          {
            orderItemReference: refs.item,
            requiredQuantity: 3,
            readyResultReference: refs.result,
            readyQuantity: 3,
            readyAt,
          },
          {
            orderItemReference: refs.otherItem,
            requiredQuantity: 2,
            readyResultReference: null,
            readyQuantity: null,
            readyAt: null,
          },
        ],
      }),
    );
    expect(bundle.orderEvent).toBeNull();
  });

  it("requires an Order Event exactly when the whole vector is Ready", () => {
    expectInvalid(() => createKitchenReadyEventBundle(input({ orderEventReference: null })));
    expectInvalid(() =>
      createKitchenReadyEventBundle(
        input({
          readiness: [
            {
              orderItemReference: refs.item,
              requiredQuantity: 3,
              readyResultReference: refs.result,
              readyQuantity: 3,
              readyAt,
            },
            {
              orderItemReference: refs.otherItem,
              requiredQuantity: 2,
              readyResultReference: null,
              readyQuantity: null,
              readyAt: null,
            },
          ],
        }),
      ),
    );
  });

  it("rejects duplicate, unsorted, false-null and mismatched target vectors", () => {
    const current = (input().readiness as readonly unknown[])[0];
    expectInvalid(() => createKitchenReadyEventBundle(input({ readiness: [current, current] })));
    expectInvalid(() =>
      createKitchenReadyEventBundle(
        input({
          orderEventReference: null,
          readiness: [
            {
              orderItemReference: refs.otherItem,
              requiredQuantity: 2,
              readyResultReference: null,
              readyQuantity: null,
              readyAt: null,
            },
            current,
          ],
        }),
      ),
    );
    expectInvalid(() =>
      createKitchenReadyEventBundle(
        input({
          readiness: [
            {
              orderItemReference: refs.item,
              requiredQuantity: 3,
              readyResultReference: refs.result,
              readyQuantity: null,
              readyAt,
            },
          ],
        }),
      ),
    );
    expectInvalid(() => createKitchenReadyEventBundle(input({ readyQuantity: 2 })));
  });

  it("strict-parses both envelopes and produces stable semantic bindings", () => {
    const bundle = createKitchenReadyEventBundle(input());
    expect(parseKitchenItemReadyEnvelope(bundle.itemEvent)).toEqual(bundle.itemEvent);
    expect(parseKitchenOrderReadyEnvelope(bundle.orderEvent)).toEqual(bundle.orderEvent);
    expect(parseKitchenReadyEnvelope(bundle.itemEvent)).toEqual(bundle.itemEvent);
    expect(createKitchenReadyEventSemanticBinding(bundle.itemEvent)).toContain(
      '"eventType":"KitchenItemReady"',
    );
  });

  it("rejects extra, symbol, accessor and proxy input without invoking accessors", () => {
    expectInvalid(() => createKitchenReadyEventBundle({ ...input(), data: {} }));
    const symbol = input() as Record<PropertyKey, unknown>;
    symbol[Symbol("unsafe")] = "unsafe";
    expectInvalid(() => createKitchenReadyEventBundle(symbol));
    let accessed = false;
    const accessor = input() as Record<string, unknown>;
    Object.defineProperty(accessor, "data", {
      enumerable: true,
      get() {
        accessed = true;
        return "unsafe";
      },
    });
    expectInvalid(() => createKitchenReadyEventBundle(accessor));
    expect(accessed).toBe(false);
    expectInvalid(() => createKitchenReadyEventBundle(new Proxy(input(), {})));
  });

  it("rejects identity alias, invalid versions and divergent envelope metadata", () => {
    expectInvalid(() =>
      createKitchenReadyEventBundle(input({ itemEventReference: refs.correlation })),
    );
    expectInvalid(() => createKitchenReadyEventBundle(input({ ticketVersion: 0n })));
    const bundle = createKitchenReadyEventBundle(input());
    expectInvalid(() =>
      parseKitchenReadyEnvelope({ ...bundle.itemEvent, producerModule: "@rms/ordering" }),
    );
    expectInvalid(() =>
      parseKitchenReadyEnvelope({ ...bundle.itemEvent, redactionClassification: "personal" }),
    );
  });

  it("contains no Customer, health, payment, Provider, Actor or narrative payload", () => {
    const serialized = JSON.stringify(createKitchenReadyEventBundle(input()), (_key, value) =>
      typeof value === "bigint" ? value.toString(10) : value,
    ).toLowerCase();
    for (const prohibited of [
      "customer",
      "note",
      "allerg",
      "health",
      "payment",
      "provider",
      "session",
      "actorid",
      "recipe",
      "station",
    ])
      expect(serialized).not.toContain(prohibited);
  });

  it("uses one bounded safe error contract", () => {
    try {
      createKitchenReadyEventBundle(null);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(KitchenReadyEventError);
      expect(error).toEqual(expect.objectContaining({ code: "KITCHEN_READY_EVENT_INVALID" }));
    }
  });
});
