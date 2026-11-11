import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantPickupQuery, waitingPickupOrders } from "./merchant-pickup-query.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  list: vi.fn(),
  cancelled: vi.fn(),
  numbers: vi.fn(),
  days: vi.fn(),
  counter: vi.fn(),
  remakes: vi.fn(),
  lines: vi.fn(),
  withdrawn: vi.fn(),
}));
vi.mock("./order-refund-withdrawal.js", () => ({ readRefundWithdrawnUnits: doubles.withdrawn }));
vi.mock("./merchant-round-business-date.js", () => ({
  withOptionalRead: async (_tx: unknown, work: () => Promise<unknown>, fallback: unknown) => {
    try {
      return await work();
    } catch {
      return fallback;
    }
  },
}));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  listOpenKitchenReworkItems: doubles.remakes,
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresStaffOrderCancellationReader: () => ({ listByOrders: doubles.cancelled }),
  listStoreOrderNumbers: doubles.numbers,
  listStoreOrderBusinessDates: doubles.days,
  listStoreCounterOrders: doubles.counter,
  loadMerchantOrderLines: doubles.lines,
}));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresFulfillmentReadinessStore: doubles.store,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantPickupQuery>[0];
function setup(configured = true) {
  const allowed = vi.fn(async () => true),
    authorize = vi.fn(async () => ({ sessionReference: id(1) }));
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work(tx));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({ listPickupQueue: doubles.list });
  doubles.cancelled.mockResolvedValue([]);
  doubles.numbers.mockResolvedValue(new Map());
  doubles.days.mockResolvedValue(new Map());
  doubles.counter.mockResolvedValue(new Set());
  doubles.remakes.mockResolvedValue([]);
  doubles.lines.mockResolvedValue(null);
  doubles.withdrawn.mockResolvedValue(new Map());
  doubles.list.mockResolvedValue({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    items: [],
    nextAfterFulfillmentReference: null,
  });
  const resolveWorkstation = vi.fn(async () => ({
    deviceReference: id(5),
    pickupLocationReference: id(6),
  }));
  const operation = createMerchantPickupQuery({
    persistence: {
      transactions: { run },
      now: () => "2026-09-19T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    store: {} as Options["store"],
    installContext: async () => undefined,
    ...(configured ? { resolveWorkstation } : {}),
  });
  const input = {
    sessionCookie: "synthetic",
    csrf: "synthetic",
    query: { afterFulfillmentReference: null, limit: 50, includeCompleted: false },
  };
  return { operation, input, resolveWorkstation, allowed, authorize, run };
}
beforeEach(() => vi.resetAllMocks());
it("defaults to no workstation and binds configured resolution to current session and Store", async () => {
  const absent = setup(false);
  expect(await absent.operation(absent.input)).toMatchObject({ workstation: null });
  const f = setup();
  expect(await f.operation(f.input)).toMatchObject({
    workstation: { deviceReference: id(5), pickupLocationReference: id(6) },
  });
  expect(f.resolveWorkstation).toHaveBeenCalledWith(expect.anything(), {
    sessionReference: id(1),
    actorReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
  });
  expect(doubles.scope).toHaveBeenLastCalledWith(
    expect.anything(),
    "synthetic",
    "fulfillment.operate",
    id(1),
  );
});
it("does not resolve workstation before authentication and permission", async () => {
  const f = setup();
  f.authorize.mockRejectedValueOnce(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "FULFILLMENT_READINESS_PERMISSION_DENIED",
  });
  expect(f.resolveWorkstation).not.toHaveBeenCalled();
});
it("rejects browser station injection and invalid configured references", async () => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, query: { ...f.input.query, deviceReference: id(9) } }),
  ).rejects.toMatchObject({ code: "FULFILLMENT_READINESS_INPUT_INVALID" });
  expect(f.resolveWorkstation).not.toHaveBeenCalled();
  f.resolveWorkstation.mockResolvedValue({
    deviceReference: "invalid",
    pickupLocationReference: id(6),
  });
  await expect(f.operation(f.input)).rejects.toThrow();
});
it("rechecks withdrawn queue permission after configured resolution", async () => {
  const f = setup();
  f.resolveWorkstation.mockImplementation(async () => {
    f.allowed.mockResolvedValue(false);
    return { deviceReference: id(5), pickupLocationReference: id(6) };
  });
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "FULFILLMENT_READINESS_PERMISSION_DENIED",
  });
});
it("WP-2423 Q6: leaves out pickup orders the Store cancelled before the kitchen started", async () => {
  const f = setup();
  const item = (n: number) => ({
    fulfillmentReference: id(40 + n),
    orderReference: id(50 + n),
    aggregateVersion: 2n,
    items: [],
  });
  doubles.list.mockResolvedValue({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    items: [item(1), item(2)],
    nextAfterFulfillmentReference: null,
  });
  doubles.cancelled.mockResolvedValue([{ orderReference: id(51) }]);
  const result = (await f.operation(f.input)) as { items: { orderReference: string }[] };
  expect(result.items.map((value) => value.orderReference)).toEqual([id(52)]);
  expect(doubles.cancelled).toHaveBeenCalledWith(expect.anything(), [id(51), id(52)]);
});

it("WP-2423 Q26: flags a remake only on the pickup whose own order item is being remade, never by number", async () => {
  const f = setup();
  const line = (n: number) => ({
    fulfillmentItemReference: id(60 + n),
    orderItemReference: id(70 + n),
    orderedQuantity: 1,
    readyQuantity: 1,
    handedOverQuantity: 0,
  });
  doubles.list.mockResolvedValue({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    items: [
      {
        fulfillmentReference: id(41),
        orderReference: id(51),
        aggregateVersion: 2n,
        items: [line(1)],
      },
      {
        fulfillmentReference: id(42),
        orderReference: id(52),
        aggregateVersion: 2n,
        items: [line(2)],
      },
    ],
    nextAfterFulfillmentReference: null,
  });
  // Both orders carry the same number (an earlier day's order and today's).
  doubles.numbers.mockResolvedValue(
    new Map([
      [id(51), "2"],
      [id(52), "2"],
    ]),
  );
  doubles.days.mockResolvedValue(
    new Map([
      [id(51), "2026-09-14"],
      [id(52), "2026-09-19"],
    ]),
  );
  doubles.remakes.mockResolvedValue([
    { orderReference: id(52), orderItemReference: id(72), openQuantity: 1 },
    // A remake for an order item that is not on that order's pickup is ignored.
    { orderReference: id(51), orderItemReference: id(99), openQuantity: 1 },
  ]);
  const result = (await f.operation(f.input)) as {
    items: {
      orderReference: string;
      remakeInProgress: number;
      businessDate: string;
      items: object[];
    }[];
  };
  expect(
    result.items.map((value) => [value.orderReference, value.remakeInProgress, value.businessDate]),
  ).toEqual([
    [id(51), 0, "2026-09-14"],
    [id(52), 1, "2026-09-19"],
  ]);
  expect(result.items[0]?.items[0]).not.toHaveProperty("orderItemReference");
});

it("WP-2423: marks the orders staff took at the counter so they are handed over in person", async () => {
  const f = setup();
  const item = (n: number) => ({
    fulfillmentReference: id(40 + n),
    orderReference: id(50 + n),
    aggregateVersion: 2n,
    items: [],
  });
  doubles.list.mockResolvedValue({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    items: [item(1), item(2)],
    nextAfterFulfillmentReference: null,
  });
  doubles.counter.mockResolvedValue(new Set([id(52)]));
  const result = (await f.operation(f.input)) as {
    items: { orderReference: string; takenAtCounter: boolean }[];
  };
  expect(result.items.map((value) => [value.orderReference, value.takenAtCounter])).toEqual([
    [id(51), false],
    [id(52), true],
  ]);
  // Ordering's read is scoped to this Store and only these orders.
  expect(doubles.counter).toHaveBeenCalledWith(
    expect.anything(),
    { brandReference: id(3), storeReference: id(4) },
    [id(51), id(52)],
  );
});

it("WP-2423: names each item from Ordering's item snapshots, on handed-over pickups too", async () => {
  const f = setup();
  const line = (n: number) => ({
    fulfillmentItemReference: id(60 + n),
    orderItemReference: id(70 + n),
    orderedQuantity: 2,
    readyQuantity: 2,
    handedOverQuantity: 0,
  });
  doubles.list.mockResolvedValue({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    items: [
      {
        fulfillmentReference: id(41),
        orderReference: id(51),
        phase: "Ready",
        aggregateVersion: 2n,
        items: [line(1), line(2)],
      },
      {
        fulfillmentReference: id(42),
        orderReference: id(52),
        phase: "Completed",
        aggregateVersion: 3n,
        items: [line(3)],
      },
    ],
    nextAfterFulfillmentReference: null,
  });
  doubles.lines.mockImplementation(async (_tx: unknown, _scope: unknown, order: string) => ({
    items:
      order === id(51)
        ? [
            {
              orderItemReference: id(71),
              name: "Latte",
              options: [{ name: "Oat milk", quantity: 1 }],
              quantity: 2,
            },
          ]
        : [{ orderItemReference: id(73), name: "Mocha", options: [], quantity: 2 }],
    totals: {},
  }));
  const result = (await f.operation(f.input)) as {
    items: { items: Record<string, unknown>[] }[];
  };
  expect(result.items[0]?.items).toEqual([
    {
      fulfillmentItemReference: id(61),
      orderedQuantity: 2,
      readyQuantity: 2,
      handedOverQuantity: 0,
      name: "Latte",
      options: [{ name: "Oat milk", quantity: 1 }],
    },
    // An item the snapshot read did not name stays unnamed.
    {
      fulfillmentItemReference: id(62),
      orderedQuantity: 2,
      readyQuantity: 2,
      handedOverQuantity: 0,
    },
  ]);
  // Owner 2026-11-03: a handed-over order still says what was in the bag.
  expect(result.items[1]?.items[0]).toMatchObject({ name: "Mocha", options: [] });
  // One Ordering read per order, scoped to this Store.
  expect(doubles.lines).toHaveBeenCalledTimes(2);
  for (const order of [id(51), id(52)])
    expect(doubles.lines).toHaveBeenCalledWith(
      expect.anything(),
      { brandReference: id(3), storeReference: id(4) },
      order,
      // Owner 2026-10-24: the staff member's chosen language first, then the Store's.
      ["en-CA"],
    );
});

it("WP-2423: keeps the queue readable when an order's item snapshots can't be read", async () => {
  const f = setup();
  doubles.list.mockResolvedValue({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    items: [
      {
        fulfillmentReference: id(41),
        orderReference: id(51),
        phase: "Ready",
        aggregateVersion: 2n,
        items: [
          {
            fulfillmentItemReference: id(61),
            orderItemReference: id(71),
            orderedQuantity: 1,
            readyQuantity: 1,
            handedOverQuantity: 0,
          },
        ],
      },
    ],
    nextAfterFulfillmentReference: null,
  });
  doubles.lines.mockRejectedValue(new Error("MERCHANT_ORDER_INDEX_UNAVAILABLE"));
  const result = (await f.operation(f.input)) as { items: { items: object[] }[] };
  expect(result.items[0]?.items[0]).not.toHaveProperty("name");
});

it("WP-2423 M10: the workspace's waiting count leaves out a pickup refunded in full, as the queue does", async () => {
  // Fulfillment records the refunded units of each line with the refund (withdrawnQuantity).
  const line = (n: number, quantity: number, withdrawnQuantity: number) => ({
    fulfillmentItemReference: id(70 + n),
    orderItemReference: id(80 + n),
    orderedQuantity: quantity,
    readyQuantity: 0,
    handedOverQuantity: 0,
    withdrawnQuantity,
  });
  const item = (n: number, lines: ReturnType<typeof line>[]) => ({
    fulfillmentReference: id(40 + n),
    orderReference: id(50 + n),
    aggregateVersion: 2n,
    items: lines,
  });
  doubles.store.mockReturnValue({ listPickupQueue: doubles.list });
  doubles.list.mockResolvedValue({
    source: "CurrentFulfillment",
    observedAt: "2026-09-19T12:00:00.000Z",
    // Order 1: both units refunded, not to be handed over. Order 2: one of two refunded.
    items: [item(1, [line(1, 2, 2)]), item(2, [line(2, 2, 1)])],
    nextAfterFulfillmentReference: null,
  });
  doubles.withdrawn.mockResolvedValue(new Map());
  const tx = { query: vi.fn(async () => ({ rows: [{ brand: null, store: null }], rowCount: 1 })) };
  const count = () =>
    waitingPickupOrders(tx, {
      sha256: (() => "") as never,
      validateCurrentSource: (() => true) as never,
      now: () => "2026-09-19T12:00:00.000Z",
      brandReference: id(3),
      storeReference: id(4),
    });
  expect(await count()).toBe(1);
  // A refund made before the pickup existed is in Ordering only: counted too.
  doubles.withdrawn.mockResolvedValue(new Map([[id(82), 2]]));
  expect(await count()).toBe(0);
  // Ordering unreadable: Fulfillment's own count (never a smaller count than is true).
  doubles.withdrawn.mockRejectedValue(new Error("ORDERING_UNAVAILABLE"));
  expect(await count()).toBe(1);
});
