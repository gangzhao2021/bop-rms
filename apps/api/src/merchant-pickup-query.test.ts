import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantPickupQuery } from "./merchant-pickup-query.js";
const doubles = vi.hoisted(() => ({ scope: vi.fn(), store: vi.fn(), list: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.scope }));
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
