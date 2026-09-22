import { expect, it } from "vitest";
import { clearSubmittedDiningCart } from "../domain/dining-cart-continuation.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const at = "2026-09-13T12:00:00.000Z";
const id = (n: number) => "0190ed24-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const f = orderWriteFixture({ at, dineIn: true });
  const order = f.request.record.order;
  return {
    cart: f.cart,
    batch: order.batches[0],
    brandReference: order.brandReference,
    storeReference: order.storeReference,
    diningSessionReference: order.diningSessionReference,
    orderReference: order.orderReference,
  };
}
it("clears exactly the submitted items while retaining the shared Cart and absolute lifetime", () => {
  const input = fixture(),
    original = JSON.stringify(input);
  const result = clearSubmittedDiningCart(input);
  expect(result.cart.cartReference).toBe(input.cart.cartReference);
  expect(result.cart.diningSessionReference).toBe(input.cart.diningSessionReference);
  expect(result.cart.aggregateVersion).toBe(input.cart.aggregateVersion + 1);
  expect(result.cart.items).toEqual([]);
  expect(result.cart.lifecycle?.absoluteExpiresAt).toBe(input.cart.lifecycle?.absoluteExpiresAt);
  expect(result.clearedItemReferences).toEqual(
    input.cart.items.map((item) => item.cartItemReference),
  );
  expect(JSON.stringify(input)).toBe(original);
});
it("rejects replay against an already advanced Cart; the writer must return its stored operation", () => {
  const input = fixture(),
    first = clearSubmittedDiningCart(input);
  expect(() => clearSubmittedDiningCart({ ...input, cart: first.cart })).toThrow();
});
it.each(["brandReference", "storeReference", "diningSessionReference", "orderReference"] as const)(
  "rejects foreign %s",
  (field) => {
    expect(() => clearSubmittedDiningCart({ ...fixture(), [field]: id(1) })).toThrow();
  },
);
it("does not clear concurrently changed Cart contents", () => {
  const input = fixture();
  expect(() =>
    clearSubmittedDiningCart({
      ...input,
      cart: { ...input.cart, aggregateVersion: input.cart.aggregateVersion + 1 },
    }),
  ).toThrow();
});
it("does not clear items omitted from the submitted Batch", () => {
  const input = fixture();
  expect(() =>
    clearSubmittedDiningCart({ ...input, batch: { ...input.batch, items: [] } }),
  ).toThrow();
});
it("does not renew an expired Cart", () => {
  const input = fixture();
  if (input.cart.lifecycle === null) throw new Error("fixture lifecycle missing");
  const expiresAt = input.cart.lifecycle.absoluteExpiresAt;
  expect(() =>
    clearSubmittedDiningCart({
      ...input,
      batch: { ...input.batch, submittedAt: expiresAt },
    }),
  ).toThrow();
});
