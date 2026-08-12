import { describe, expect, it } from "vitest";
import { orderDetailFixture, orderQueueFixture } from "./order-queue.fixtures.js";
import {
  parseOrderDetailView,
  parseOrderQueueView,
  parseOrderRouteReference,
} from "./order-queue.js";

describe("WP-1803 Order Queue browser contracts", () => {
  it("admits a closed Store and Business-Date queue", () => {
    expect(parseOrderQueueView(orderQueueFixture())).toMatchObject({
      screenId: "OPS-ORDER-QUEUE",
      freshnessStatus: "Fresh",
      items: [{ orderNumber: "ORD-1001", claimStatus: "Unavailable" }],
    });
  });

  it("rejects open, duplicate and invented collaborating facts", () => {
    expect(() => parseOrderQueueView({ ...orderQueueFixture(), customerPhone: "555" })).toThrow();
    expect(() =>
      parseOrderQueueView({
        ...orderQueueFixture(),
        items: [orderQueueFixture().items[0], orderQueueFixture().items[0]],
      }),
    ).toThrow();
    expect(() =>
      parseOrderQueueView({
        ...orderQueueFixture(),
        items: [{ ...orderQueueFixture().items[0], paymentStatus: "Paid" }],
      }),
    ).toThrow();
  });

  it("binds detail batch counts and rejects mismatches", () => {
    expect(parseOrderDetailView(orderDetailFixture())).toMatchObject({
      screenId: "OPS-ORDER-DETAIL",
      batches: [{ sequence: 1 }],
    });
    expect(() => parseOrderDetailView({ ...orderDetailFixture(), batches: [] })).toThrow();
    expect(() =>
      parseOrderDetailView({
        ...orderDetailFixture(),
        batches: [{ ...orderDetailFixture().batches[0], itemCount: 1 }],
      }),
    ).toThrow();
  });

  it("rejects contradictory fulfillment facts", () => {
    expect(() =>
      parseOrderQueueView({
        ...orderQueueFixture(),
        items: [
          {
            ...orderQueueFixture().items[0],
            canonicalPhase: "Fulfilled",
            fulfilledAt: null,
            fulfillmentStatus: "Completed",
          },
        ],
      }),
    ).toThrow();
  });

  it("accepts only UUIDv7 Order routes", () => {
    expect(parseOrderRouteReference("018f7600-0000-7000-8000-000000000001")).toContain("-7");
    expect(() => parseOrderRouteReference("ORD-1001")).toThrow();
  });
});
