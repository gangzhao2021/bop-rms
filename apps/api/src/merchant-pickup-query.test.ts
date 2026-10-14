import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantPickupQuery } from "./merchant-pickup-query.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  list: vi.fn(),
  cancelled: vi.fn(),
  numbers: vi.fn(),
  days: vi.fn(),
  remakes: vi.fn(),
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
  doubles.remakes.mockResolvedValue([]);
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
