import { KitchenReworkError } from "@rms/kitchen";
import { beforeEach, expect, it, vi } from "vitest";
import {
  closeUncollectedPickupPermission,
  createMerchantPickupNotCollected,
} from "./merchant-pickup-not-collected.js";
const doubles = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  close: vi.fn(),
  kitchen: vi.fn(),
  cancelRemakes: vi.fn(),
}));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  createPostgresKitchenReworkStore: doubles.kitchen,
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresPickupHandoffStore: doubles.store,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantPickupNotCollected>[0];
function setup() {
  const authorize = vi.fn(async () => ({ sessionReference: id(1) })),
    allowed = vi.fn(async () => true);
  const run = vi.fn(async (work: (tx: object) => Promise<unknown>) => work({ query: vi.fn() }));
  doubles.scope.mockResolvedValue({
    actorReference: id(2),
    context: { brand: { brandReference: id(3) } },
    store: { storeReference: id(4) },
    allowed,
  });
  doubles.store.mockReturnValue({ closeUncollected: doubles.close });
  doubles.kitchen.mockReturnValue({ cancelOpenForOrder: doubles.cancelRemakes });
  doubles.cancelRemakes.mockResolvedValue({ cancelledQuantity: 0 });
  doubles.close.mockResolvedValue({
    status: "Applied",
    record: { fulfillmentReference: id(6), closedAt: "2026-10-09T05:00:00.000Z" },
  });
  const operation = createMerchantPickupNotCollected({
    persistence: {
      transactions: { run },
      now: () => "2026-10-09T05:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize } as unknown as Options["authentication"],
    store: {} as Options["store"],
    installContext: vi.fn(async () => undefined),
    nextReference: () => id(20),
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    command: {
      orderReference: id(5),
      storeReference: id(4),
      expectedAggregateVersion: "7",
      idempotencyReference: id(11),
      correlationReference: id(12),
    },
  };
  return { operation, input, authorize, allowed, run };
}
beforeEach(() => vi.resetAllMocks());
it("WP-2423: closes with the cancellation permission, server time and current staff", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({
    status: "Applied",
    fulfillmentReference: id(6),
    closedAt: "2026-10-09T05:00:00.000Z",
  });
  expect(doubles.scope.mock.calls[0]?.[2]).toBe(closeUncollectedPickupPermission);
  expect(closeUncollectedPickupPermission).toBe("ordering.order.cancel");
  expect(doubles.store.mock.calls[0]?.[0].actorReference).toBe(id(2));
  expect(doubles.close.mock.calls[0]?.[0]).toMatchObject({
    orderReference: id(5),
    expectedAggregateVersion: 7n,
    notCollectedReference: id(20),
    idempotencyReference: id(11),
    closedAt: "2026-10-09T05:00:00.000Z",
  });
});
it("WP-2423: refuses browser authority, another Store and a withdrawn permission", async () => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, command: { ...f.input.command, closedAt: "2026-01-01" } }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_INPUT_INVALID" });
  await expect(
    f.operation({ ...f.input, command: { ...f.input.command, storeReference: id(99) } }),
  ).rejects.toMatchObject({ code: "PICKUP_HANDOFF_PERMISSION_DENIED" });
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_PERMISSION_DENIED",
  });
  expect(doubles.close).not.toHaveBeenCalled();
});
it("WP-2423: resolves the caller in full once at the start and once before the commit", async () => {
  const f = setup();
  const access = {
    actorReference: id(2),
    orderReference: id(5),
    permission: "fulfillment.pickup.complete",
  };
  const during: boolean[] = [];
  doubles.close.mockImplementation(async (request: { transaction: object }) => {
    const store = doubles.store.mock.calls[0]?.[0];
    during.push(await store.authorize(request.transaction, access));
    // Not this run's transaction, or another order: refused without a query.
    during.push(await store.authorize({ query: vi.fn() }, access));
    during.push(await store.authorize(request.transaction, { ...access, orderReference: id(99) }));
    return { status: "Applied", record: { fulfillmentReference: id(6), closedAt: "x" } };
  });
  await f.operation(f.input);
  expect(during).toEqual([true, false, false]);
  expect(doubles.scope).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
  // The guard ends with the run.
  const transaction = doubles.close.mock.calls[0]?.[0].transaction;
  expect(await doubles.store.mock.calls[0]?.[0].authorize(transaction, access)).toBe(false);
});
it("WP-2423: a permission withdrawn or Session ended during the close refuses it before commit", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  let rolledBack: unknown = null;
  f.run.mockImplementation(async (work: (tx: object) => Promise<unknown>) =>
    work({ query: vi.fn() }).catch((error: unknown) => {
      rolledBack = error;
      throw error;
    }),
  );
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_PERMISSION_DENIED",
  });
  // The refusal is thrown inside the transaction callback, so nothing it wrote commits.
  expect(rolledBack).toMatchObject({ code: "PICKUP_HANDOFF_PERMISSION_DENIED" });
  expect(doubles.close).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledTimes(2);
});
it("WP-2423: a remake still being made for the order is cancelled with the closure, once", async () => {
  const f = setup();
  doubles.cancelRemakes.mockResolvedValue({ cancelledQuantity: 2 });
  await f.operation(f.input);
  expect(doubles.kitchen.mock.calls[0]?.[0]).toMatchObject({
    brandReference: id(3),
    storeReference: id(4),
  });
  const transaction = doubles.close.mock.calls[0]?.[0].transaction;
  expect(doubles.cancelRemakes).toHaveBeenCalledWith(transaction, {
    orderReference: id(5),
    actorReference: id(2),
    occurredAt: "2026-10-09T05:00:00.000Z",
    correlationReference: id(12),
  });
  // A replay of the same close changes nothing more.
  doubles.close.mockResolvedValue({
    status: "AlreadyApplied",
    record: { fulfillmentReference: id(6), closedAt: "2026-10-09T05:00:00.000Z" },
  });
  doubles.cancelRemakes.mockClear();
  await f.operation(f.input);
  expect(doubles.cancelRemakes).not.toHaveBeenCalled();
});
it("WP-2423: a remake that can't be cancelled fails the whole close (retry the same close)", async () => {
  const f = setup();
  doubles.cancelRemakes.mockRejectedValue(new KitchenReworkError("KITCHEN_REWORK_UNAVAILABLE"));
  await expect(f.operation(f.input)).rejects.toMatchObject({
    code: "PICKUP_HANDOFF_INPUT_INVALID",
  });
});
