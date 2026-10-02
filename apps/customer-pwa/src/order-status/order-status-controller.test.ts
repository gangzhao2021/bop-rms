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
  it("discards an in-flight read and realtime hints when context changes", async () => {
    let contextChanged: (() => void) | undefined;
    let callbacks: OrderStatusSubscriptionCallbacks | undefined;
    let finish!: (result: unknown) => void;
    let calls = 0;
    const controller = createOrderStatusController(id(1), {
      subscribeContextChange: (listener) => {
        contextChanged = listener;
        return () => undefined;
      },
      load: async () => {
        calls += 1;
        return calls === 1
          ? view()
          : new Promise((resolve) => {
              finish = resolve;
            });
      },
      subscribe: (_reference, value) => {
        callbacks = value;
        return () => undefined;
      },
    });
    await controller.load();
    const pending = controller.refresh();
    contextChanged?.();
    callbacks?.onOpen();
    callbacks?.onHint();
    finish(view());
    await pending;
    expect(calls).toBe(2);
    expect(controller.getState()).toEqual({ status: "permission-denied" });
    controller.dispose();
  });

  it("releases context observers and ignores old callbacks after remount", async () => {
    const callbacks: (() => void)[] = [];
    let released = 0;
    const controller = createOrderStatusController(id(1), {
      subscribeContextChange: (listener) => {
        callbacks.push(listener);
        return () => {
          released += 1;
        };
      },
      load: async () => view(),
      subscribe: () => () => undefined,
    });
    await controller.load();
    controller.dispose();
    expect(controller.getState()).toEqual({ status: "loading" });
    expect(released).toBe(1);
    await controller.load();
    const remounted = controller.getState();
    callbacks[0]?.();
    expect(controller.getState()).toBe(remounted);
    callbacks[1]?.();
    expect(controller.getState()).toEqual({ status: "permission-denied" });
    controller.dispose();
    expect(released).toBe(2);
  });

  it("ignores queued realtime callbacks from before the offline lifecycle", async () => {
    let calls = 0;
    let callbacks: OrderStatusSubscriptionCallbacks | undefined;
    const controller = createOrderStatusController(id(1), {
      load: async () => {
        calls += 1;
        return view();
      },
      subscribe: (_reference, value) => {
        callbacks = value;
        return () => undefined;
      },
    });
    await controller.load();
    controller.setOnline(false);
    controller.setOnline(true);
    const retained = controller.getState();
    callbacks?.onOpen();
    callbacks?.onHint();
    callbacks?.onError();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(controller.getState()).toBe(retained);
    controller.dispose();
  });

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

describe("independent order status sources", () => {
  function sourced() {
    return {
      ...view(),
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: {
          batches: [
            { orderBatchReference: id(3), status: "Ready", updatedAt: "2026-08-11T13:59:00.000Z" },
          ],
        },
        payments: [
          {
            status: "Succeeded",
            occurredAt: "2026-08-11T13:56:00.000Z",
            amount: { amountMinor: 2598n, currencyCode: "CAD" },
            freshnessStatus: "Stale",
          },
        ],
      },
    };
  }
  it("accepts a scoped nonempty subset without inventing another batch state", () => {
    const input = sourced();
    const first = input.order.batches[0];
    if (!first) throw new Error("fixture");
    input.order.batches.push({
      ...first,
      orderBatchReference: id(30),
      items: first.items.map((item) => ({ ...item, orderItemReference: id(31) })),
    });
    const parsed = parseOrderStatusView(input, id(1));
    expect(parsed.order.batches).toHaveLength(2);
    expect(parsed.sources?.kitchen?.batches).toEqual(input.sources.kitchen.batches);
  });
  it("admits exact batch evidence and preserves independent payment freshness", () => {
    const input = sourced();
    expect(parseOrderStatusView(input, id(1)).sources).toEqual(input.sources);
  });
  it.each([
    "missing-batch",
    "wrong-batch",
    "duplicate-batch",
    "extra-field",
    "future-time",
    "invalid-date",
    "failed-with-money",
    "zero-success",
    "wrong-currency",
  ] as const)("rejects %s source claims", (kind) => {
    const input = sourced();
    const batch = input.sources.kitchen.batches[0];
    const payment = input.sources.payments[0];
    if (!batch || !payment) throw new Error("missing fixture source");
    if (kind === "missing-batch") input.sources.kitchen.batches = [];
    if (kind === "wrong-batch") batch.orderBatchReference = id(99);
    if (kind === "duplicate-batch") input.sources.kitchen.batches.push(batch);
    if (kind === "extra-field") Object.assign(input.sources, { privateReference: id(10) });
    if (kind === "future-time") payment.occurredAt = "2026-08-12T14:00:00.000Z";
    if (kind === "invalid-date") input.sources.checkedAt = "2026-02-30T14:00:00.000Z";
    if (kind === "failed-with-money") payment.status = "Failed";
    if (kind === "zero-success") payment.amount.amountMinor = 0n;
    if (kind === "wrong-currency") payment.amount.currencyCode = "USD";
    expect(() => parseOrderStatusView(input, id(1))).toThrow();
  });
  it("preserves unavailable sources and an empty terminal-result list without inferring payment", () => {
    expect(
      parseOrderStatusView(
        {
          ...view(),
          sources: {
            checkedAt: "2026-08-11T14:00:00.000Z",
            kitchen: null,
            payments: [],
          },
        },
        id(1),
      ),
    ).toMatchObject({
      sources: { kitchen: null, payments: [] },
      order: { paymentStatus: "NotReported" },
    });
  });
});

it.each(["Accepted", "In Progress", "Ready", "Rejected", "Cancelled"])(
  "accepts canonical %s without inventing fulfillment completion",
  (canonicalPhase) => {
    const original = view();
    const parsed = parseOrderStatusView(
      {
        ...original,
        order: { ...original.order, canonicalPhase },
      },
      id(1),
    );
    expect(parsed.order.canonicalPhase).toBe(canonicalPhase);
    expect(parsed.order.fulfilledAt).toBeNull();
  },
);

describe("Dining serving source", () => {
  const parse = (value: unknown) => parseOrderStatusView(value, id(1));
  const servedView = (servedQuantity = 1) => {
    const result = view();
    return {
      ...result,
      order: { ...result.order, orderType: "DineIn" },
      sources: {
        checkedAt: "2026-08-11T14:00:00.000Z",
        kitchen: null,
        payments: null,
        dining: {
          items: [{ orderItemReference: id(4), orderBatchReference: id(3), servedQuantity }],
        },
      },
    };
  };
  it("accepts partial serving without changing payment or canonical projection", () => {
    const result = parse(servedView());
    expect(result.sources?.dining?.items[0]?.servedQuantity).toBe(1);
    expect(result.order.canonicalPhase).toBe("Submitted");
    expect(result.order.paymentStatus).toBe("NotReported");
  });
  it.each([-1, 0.5, 3])("rejects impossible serving quantity %s", (quantity) => {
    expect(() => parse(servedView(quantity))).toThrow();
  });
  it("rejects missing, foreign, duplicate and Pickup serving evidence", () => {
    const result = servedView();
    expect(() => parse({ ...result, order: { ...result.order, orderType: "Pickup" } })).toThrow();
    expect(() =>
      parse({ ...result, sources: { ...result.sources, dining: { items: [] } } }),
    ).toThrow();
    result.sources.dining.items[0] = {
      orderItemReference: id(99),
      orderBatchReference: id(3),
      servedQuantity: 1,
    };
    expect(() => parse(result)).toThrow();
    const duplicate = servedView();
    duplicate.sources.dining.items.push({
      orderItemReference: id(4),
      orderBatchReference: id(3),
      servedQuantity: 1,
    });
    expect(() => parse(duplicate)).toThrow();
  });
});

it("resumes an explicit load after effect cleanup without accepting the old request", async () => {
  let finishOld: (value: ReturnType<typeof view>) => void = () => undefined;
  let calls = 0;
  let subscriptions = 0;
  const controller = createOrderStatusController(id(1), {
    load: async () => {
      calls++;
      if (calls === 1)
        return new Promise<ReturnType<typeof view>>((resolve) => {
          finishOld = resolve;
        });
      return { ...view(), order: { ...view().order, orderNumber: "1002" } };
    },
    subscribe: () => {
      subscriptions++;
      return () => undefined;
    },
  });
  const old = controller.load();
  controller.dispose();
  await controller.refresh();
  expect(calls).toBe(1);
  await controller.load();
  finishOld(view());
  await old;
  expect(controller.getState()).toMatchObject({
    status: "ready",
    view: { order: { orderNumber: "1002" } },
  });
  expect(subscriptions).toBe(1);
});

it("ignores callbacks from a subscription disposed before remount", async () => {
  const callbacks: OrderStatusSubscriptionCallbacks[] = [];
  let calls = 0;
  let closed = 0;
  const controller = createOrderStatusController(id(1), {
    load: async () => {
      calls++;
      return view();
    },
    subscribe: (_reference, next) => {
      callbacks.push(next);
      return () => {
        closed++;
      };
    },
  });
  await controller.load();
  controller.dispose();
  await controller.load();
  expect(closed).toBe(1);
  callbacks[0]?.onOpen();
  callbacks[0]?.onHint();
  callbacks[0]?.onError();
  expect(calls).toBe(2);
  callbacks[1]?.onHint();
  expect(calls).toBe(3);
  controller.dispose();
  expect(closed).toBe(2);
});
