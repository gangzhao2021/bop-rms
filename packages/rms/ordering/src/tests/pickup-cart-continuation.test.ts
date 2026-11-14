import { expect, it } from "vitest";
import { clearSubmittedPickupCart } from "../domain/pickup-cart-continuation.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const at = "2026-11-06T12:00:00.000Z";
const id = (n: number) => "01902423-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture(pos = false) {
  const f = orderWriteFixture({ at, pos });
  const order = f.request.record.order;
  return {
    cart: f.cart,
    batch: order.batches[0],
    brandReference: order.brandReference,
    storeReference: order.storeReference,
    orderReference: order.orderReference,
  };
}
it.each([false, true])(
  "WP-2423 M03: empties the ordered pickup Cart at its next version (counter=%s)",
  (pos) => {
    const input = fixture(pos),
      original = JSON.stringify(input);
    expect(input.cart.orderType).toBe("Pickup");
    const result = clearSubmittedPickupCart(input);
    expect(result.cart.cartReference).toBe(input.cart.cartReference);
    expect(result.cart.createdByActorReference).toBe(input.cart.createdByActorReference);
    expect(result.cart.aggregateVersion).toBe(input.cart.aggregateVersion + 1);
    expect(result.cart.items).toEqual([]);
    expect(result.cart.lifecycle?.status).toBe("Active");
    expect(result.cart.lifecycle?.absoluteExpiresAt).toBe(input.cart.lifecycle?.absoluteExpiresAt);
    expect(result.previousCartVersion).toBe(input.cart.aggregateVersion);
    expect(result.clearedItemReferences).toEqual(
      input.cart.items.map((item) => item.cartItemReference),
    );
    expect(JSON.stringify(input)).toBe(original);
  },
);
it("WP-2423 M03: never clears a Cart twice; the writer returns its stored Order instead", () => {
  const input = fixture(),
    first = clearSubmittedPickupCart(input);
  expect(() => clearSubmittedPickupCart({ ...input, cart: first.cart })).toThrow();
});
it.each(["brandReference", "storeReference", "orderReference"] as const)(
  "WP-2423 M03: rejects a foreign %s",
  (field) => {
    expect(() => clearSubmittedPickupCart({ ...fixture(), [field]: id(1) })).toThrow();
  },
);
it("WP-2423 M03: never clears a table Cart, a changed Cart or dishes left out of the Order", () => {
  const input = fixture();
  const table = orderWriteFixture({ at, dineIn: true });
  expect(() =>
    clearSubmittedPickupCart({
      ...input,
      cart: table.cart,
      batch: table.request.record.order.batches[0],
      orderReference: table.request.record.order.orderReference,
    }),
  ).toThrow();
  expect(() =>
    clearSubmittedPickupCart({
      ...input,
      cart: { ...input.cart, aggregateVersion: input.cart.aggregateVersion + 1 },
    }),
  ).toThrow();
  expect(() =>
    clearSubmittedPickupCart({ ...input, batch: { ...input.batch, items: [] } }),
  ).toThrow();
});
