import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ find: vi.fn(), options: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresMerchantOrderIndex: (options: unknown) => {
    mock.options(options);
    return { find: mock.find };
  },
}));
import { createDiningOrderCloseConfiguration } from "./dining-order-close-configuration.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    selected = { ...scope, actorReference: id(4) },
    command = {
      orderReference: id(5),
      operationReference: id(6),
      expectedOrderVersion: 3,
      expectedClosureVersion: 0,
      reasonCode: "ORDER_SETTLED",
    };
  const order = {
    orderReference: id(5),
    orderType: "DineIn",
    diningSessionReference: id(7),
    guestSessionReference: id(8),
  };
  mock.find.mockResolvedValue(order);
  const authority = { authorize: vi.fn(async () => true) },
    tx = { query: vi.fn() },
    resolve = createDiningOrderCloseConfiguration({
      ...scope,
      providerAccountReference: id(9),
      environment: "Test",
    });
  return {
    order,
    selected,
    authority,
    tx,
    command,
    run: () => resolve(tx, selected, command, authority),
  };
}
it("loads immutable owner binding using current command authority", async () => {
  const f = setup();
  expect(await f.run()).toEqual({
    providerAccountReference: id(9),
    environment: "Test",
    diningSessionReference: id(7),
    guestSessionReference: id(8),
  });
  expect(mock.find).toHaveBeenCalledWith({ transaction: f.tx, orderReference: id(5) });
  await mock.options.mock.calls[0]?.[0].authorize();
  expect(f.authority.authorize).toHaveBeenCalledTimes(3);
});
it.each(["tenantReference", "brandReference", "storeReference"] as const)(
  "rejects foreign %s before lookup",
  async (key) => {
    const f = setup();
    f.selected[key] = id(99);
    await expect(f.run()).rejects.toThrow();
    expect(mock.find).not.toHaveBeenCalled();
  },
);
it.each([
  null,
  {
    orderReference: id(99),
    orderType: "DineIn",
    diningSessionReference: id(7),
    guestSessionReference: id(8),
  },
  {
    orderReference: id(5),
    orderType: "Pickup",
    diningSessionReference: null,
    guestSessionReference: id(8),
  },
])("rejects unavailable or incompatible Order %#", async (order) => {
  const f = setup();
  mock.find.mockResolvedValue(order);
  await expect(f.run()).rejects.toThrow();
});
it("permission revocation cannot return configuration", async () => {
  const f = setup();
  f.authority.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
});
it("invalid provider configuration cannot construct resolver", () => {
  expect(() =>
    createDiningOrderCloseConfiguration({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      providerAccountReference: "invalid",
      environment: "Test",
    }),
  ).toThrow();
});
