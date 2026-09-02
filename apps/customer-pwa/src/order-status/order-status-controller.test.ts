import { describe, expect, it } from "vitest";
import {
  createOrderStatusController,
  createUnavailableOrderStatusClient,
  OrderStatusClientError,
  parseOrderStatusView,
  type CustomerOrderStatusClient,
  type OrderStatusSubscriptionCallbacks,
} from "./order-status-controller.js";

const id = (n: number) => `018f7a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function view(orderReference = id(1)) {
  return {
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    sourceCheckpoint: id(2),
    projectedAt: "2026-08-11T14:00:00.000Z",
    freshnessStatus: "Fresh",
    order: {
      orderReference,
      orderNumber: "1001",
      orderType: "Pickup",
      canonicalPhase: "Submitted",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Unavailable",
      fulfilledAt: null,
      eta: null,
      submittedAt: "2026-08-11T13:55:00.000Z",
      batches: [
        {
          orderBatchReference: id(3),
          submittedAt: "2026-08-11T13:55:00.000Z",
          items: [
            {
              orderItemReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 2,
              lineTotal: { amountMinor: 2598n, currencyCode: "CAD" },
            },
          ],
        },
      ],
    },
  };
}

describe("WP-1705 Order Status controller", () => {
  it("keeps the default browser runtime unavailable without a public request", async () => {
    const controller = createOrderStatusController(id(1), createUnavailableOrderStatusClient());
    await controller.load();
    expect(controller.getState()).toEqual({ status: "unavailable" });
  });

  it("rejects an invalid route before load or subscription", async () => {
    let calls = 0;
    const client: CustomerOrderStatusClient = {
      load: async () => {
        calls += 1;
        return view();
      },
      subscribe: () => {
        calls += 1;
        return () => undefined;
      },
    };
    const controller = createOrderStatusController("not-a-reference", client);
    await controller.load();
    await controller.refresh();
    expect(controller.getState()).toEqual({ status: "invalid-reference" });
    expect(calls).toBe(0);
  });

  it("uses the canonical Query for initial load, open, reconnect hint and manual refresh", async () => {
    const calls: string[] = [];
    let callbacks: OrderStatusSubscriptionCallbacks | undefined;
    const client: CustomerOrderStatusClient = {
      load: async (orderReference) => {
        calls.push(orderReference);
        return view(orderReference);
      },
      subscribe: (_orderReference, value) => {
        callbacks = value;
        return () => undefined;
      },
    };
    const controller = createOrderStatusController(id(1), client);
    await controller.load();
    callbacks?.onOpen();
    await Promise.resolve();
    callbacks?.onHint();
    await Promise.resolve();
    await controller.refresh();
    expect(calls).toEqual([id(1), id(1), id(1), id(1)]);
    expect(controller.getState()).toMatchObject({ status: "ready", realtime: "available" });
  });

  it("keeps the last accepted view offline and never refreshes automatically on reconnect", async () => {
    let calls = 0;
    let disposed = 0;
    const client: CustomerOrderStatusClient = {
      load: async () => {
        calls += 1;
        return view();
      },
      subscribe: () => () => {
        disposed += 1;
      },
    };
    const controller = createOrderStatusController(id(1), client);
    await controller.load();
    controller.setOnline(false);
    expect(controller.getState()).toMatchObject({ status: "offline", view: view() });
    controller.setOnline(true);
    expect(calls).toBe(1);
    expect(disposed).toBe(1);
  });

  it.each([
    ["permission_denied", "permission-denied"],
    ["not_found", "not-found"],
    ["feature_disabled", "feature-disabled"],
    ["service_unavailable", "unavailable"],
  ] as const)("maps %s without exposing an internal error", async (code, status) => {
    const client: CustomerOrderStatusClient = {
      load: async () => {
        throw new OrderStatusClientError(code);
      },
      subscribe: () => () => undefined,
    };
    const controller = createOrderStatusController(id(1), client);
    await controller.load();
    expect(controller.getState()).toEqual({ status });
  });

  it("rejects extra, accessor, symbol, custom-prototype and inconsistent results", () => {
    const candidates = [
      { ...view(), privateGuestSession: id(9) },
      Object.defineProperty(view(), "projectionName", {
        enumerable: true,
        get: () => "ordering_order_status_v1",
      }),
      { ...view(), [Symbol("secret")]: true },
      Object.assign(Object.create({ inherited: true }), view()),
      { ...view(), order: { ...view().order, canonicalPhase: "Fulfilled" } },
      { ...view(), order: { ...view().order, orderReference: id(9) } },
    ];
    for (const candidate of candidates)
      expect(() => parseOrderStatusView(candidate, id(1))).toThrow("invalid order status");
  });

  it("deep-freezes the accepted customer-safe view", () => {
    const accepted = parseOrderStatusView(view(), id(1));
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.order)).toBe(true);
    expect(Object.isFrozen(accepted.order.batches)).toBe(true);
    expect(Object.isFrozen(accepted.order.batches[0]?.items[0]?.lineTotal)).toBe(true);
  });
});
