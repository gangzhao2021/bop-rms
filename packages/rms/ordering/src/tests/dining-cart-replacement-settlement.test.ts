import { expect, it, vi } from "vitest";
import { createDiningCartReplacementSettlementGate } from "../application/dining-cart-replacement-settlement.js";
import { expireCartLifecycle } from "../domain/cart-lifecycle.js";
import { parseCheckoutSessionAllocation } from "../domain/checkout-session-allocation.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const id = (n: number) => "0190ed99-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const initial = orderWriteFixture({ at: "2026-09-13T12:00:00.000Z", dineIn: true }).cart;
  if (!initial.lifecycle) throw new Error("fixture");
  const at = initial.lifecycle.absoluteExpiresAt;
  const cart = {
    ...initial,
    aggregateVersion: initial.aggregateVersion + 1,
    updatedAt: at,
    lifecycle: expireCartLifecycle(initial.lifecycle, at),
  };
  const scope = { brandReference: cart.brandReference, storeReference: cart.storeReference };
  const allocation = (n: number) =>
    parseCheckoutSessionAllocation({
      ...scope,
      guestSessionReference: id(1),
      createOperationReference: id(n),
      cartReference: cart.cartReference,
      cartVersion: initial.aggregateVersion,
      quoteReference: id(n + 10),
      quoteVersion: 1,
      checkoutSessionReference: id(n + 20),
      submissionReference: id(n + 30),
      paymentOperationReference: id(n + 40),
      allocatedAt: initial.createdAt,
    });
  const history = vi.fn(async () => [allocation(2), allocation(3)]),
    observe = vi.fn(async () => ({ status: "Confirmed" as "Confirmed" | "Unresolved" })),
    authorize = vi.fn(async () => true),
    now = vi.fn(() => at as string);
  const gate = createDiningCartReplacementSettlementGate({
    scope,
    history,
    observe,
    authorize,
    now,
  });
  return { cart, initial, at, gate, history, observe, authorize, now, tx: {}, allocation };
}
it("checks every allocation on the supplied transaction and reauthorizes", async () => {
  const f = fixture();
  expect(await f.gate.clear(f.tx, f.cart, f.at)).toBe(true);
  expect(f.history).toHaveBeenCalledWith(f.tx, {
    cartReference: f.cart.cartReference,
    expectedCartVersion: f.cart.aggregateVersion,
    observedAt: f.at,
  });
  expect(f.observe).toHaveBeenNthCalledWith(1, f.tx, f.allocation(2));
  expect(f.observe).toHaveBeenNthCalledWith(2, f.tx, f.allocation(3));
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("does not substitute another completed attempt for one unresolved allocation", async () => {
  const f = fixture();
  f.observe
    .mockResolvedValueOnce({ status: "Confirmed" })
    .mockResolvedValueOnce({ status: "Unresolved" });
  expect(await f.gate.clear(f.tx, f.cart, f.at)).toBe(false);
});
it("empty allocation history has no allocated checkout to resolve", async () => {
  const f = fixture();
  f.history.mockResolvedValue([]);
  expect(await f.gate.clear(f.tx, f.cart, f.at)).toBe(true);
  expect(f.observe).not.toHaveBeenCalled();
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each(["brandReference", "storeReference", "cartReference"])(
  "denies allocation with foreign %s",
  async (field) => {
    const f = fixture();
    f.history.mockResolvedValue([{ ...f.allocation(2), [field]: id(90) }]);
    expect(await f.gate.clear(f.tx, f.cart, f.at)).toBe(false);
    expect(f.observe).not.toHaveBeenCalled();
  },
);
it("denies repeated allocation identities", async () => {
  const f = fixture();
  f.history.mockResolvedValue([f.allocation(2), f.allocation(2)]);
  expect(await f.gate.clear(f.tx, f.cart, f.at)).toBe(false);
});
it.each([true, false])(
  "requires current authorization at both boundaries first=%s",
  async (first) => {
    const f = fixture();
    if (first) f.authorize.mockResolvedValue(false);
    else f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await f.gate.clear(f.tx, f.cart, f.at)).toBe(false);
  },
);
it("does not expire an Active cart implicitly", async () => {
  const f = fixture();
  expect(await f.gate.clear(f.tx, f.initial, f.at)).toBe(false);
  expect(f.history).not.toHaveBeenCalled();
});
it("bounds owner failures and rejects clock rollback", async () => {
  const f = fixture();
  f.history.mockRejectedValue(new Error("private"));
  await expect(f.gate.clear(f.tx, f.cart, f.at)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
    message: "cart is unavailable",
  });
  const g = fixture();
  g.now.mockReturnValue(g.initial.createdAt);
  await expect(g.gate.clear(g.tx, g.cart, g.at)).rejects.toMatchObject({
    code: "CART_DEPENDENCY_UNAVAILABLE",
  });
});
