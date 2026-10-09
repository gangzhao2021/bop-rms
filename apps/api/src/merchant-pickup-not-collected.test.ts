import { beforeEach, expect, it, vi } from "vitest";
import {
  closeUncollectedPickupPermission,
  createMerchantPickupNotCollected,
} from "./merchant-pickup-not-collected.js";
const doubles = vi.hoisted(() => ({ scope: vi.fn(), store: vi.fn(), close: vi.fn() }));
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
