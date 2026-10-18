import { describe, expect, it, vi } from "vitest";
import {
  CartError,
  type CustomerCartDisplayView,
  type PickupCartRemovalResult,
} from "@rms/ordering";
import { createCustomerCartRemovalPort } from "./customer-cart-removal-composition.js";
const credential = "a".repeat(43);
const reference = "018f5500-0000-7000-8000-000000000001";
const context = { guestCredential: credential, requestedAt: "2026-09-08T12:00:00.000Z" };
const view: CustomerCartDisplayView = {
  schemaVersion: 1,
  cart: {
    cartReference: reference,
    version: 1,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2026-09-08T13:00:00.000Z",
      absoluteExpiresAt: "2026-09-09T12:00:00.000Z",
    },
    items: [],
    quote: null,
    warnings: [],
  },
};

const input = {
  ...context,
  cartReference: reference,
  cartItemReference: reference.slice(0, -1) + "2",
  csrfCredential: "b".repeat(43),
  operationReference: reference.slice(0, -1) + "3",
  expectedCartVersion: 1,
};
const receipt = {
  status: "Applied",
  cartReference: reference,
  cartItemReference: input.cartItemReference,
  aggregateVersion: 2,
} as PickupCartRemovalResult;
const current = { ...view, cart: { ...view.cart, version: 2 } };
function setup() {
  const read = vi.fn(async (): Promise<CustomerCartDisplayView | null> => current);
  const remove = vi.fn(async () => receipt);
  return {
    read,
    remove,
    port: createCustomerCartRemovalPort({ query: { read }, removal: { remove } }),
  };
}
describe("Pickup removal HTTP bridge", () => {
  it.each(["Applied", "AlreadyApplied"] as const)(
    "returns a freshly authorized view for %s",
    async (status) => {
      const f = setup();
      f.remove.mockResolvedValue({ ...receipt, status });
      f.read.mockResolvedValue({ ...current, cart: { ...current.cart, version: 3 } });
      expect(await f.port.removeItem(input)).toMatchObject({
        status: "Applied",
        view: { cart: { version: 3 } },
      });
      expect(f.remove).toHaveBeenCalledWith({
        sessionCredential: credential,
        csrfCredential: input.csrfCredential,
        cartReference: reference,
        cartItemReference: input.cartItemReference,
        operationReference: input.operationReference,
        expectedAggregateVersion: 1,
      });
      expect(f.read).toHaveBeenCalledWith({
        sessionCredential: credential,
        cartReference: reference,
      });
    },
  );
  it.each([new CartError("CART_PERMISSION_DENIED"), new Error("synthetic restricted failure")])(
    "preserves uncertainty after command success",
    async (error) => {
      const f = setup();
      f.read.mockRejectedValue(error);
      expect(await f.port.removeItem(input)).toEqual({ status: "Unavailable" });
    },
  );
  it.each([
    null,
    view,
    { ...current, cart: { ...current.cart, cartReference: input.cartItemReference } },
    { ...current, cart: { ...current.cart, version: NaN } },
    {
      ...current,
      cart: { ...current.cart, items: [{ cartItemReference: input.cartItemReference }] },
    },
  ])("rejects an inconsistent post-command view", async (result) => {
    const f = setup();
    f.read.mockResolvedValue(result as never);
    expect(await f.port.removeItem(input)).toEqual({ status: "Unavailable" });
  });
  it("bounds malformed command receipts before public reads", async () => {
    const f = setup();
    f.remove.mockResolvedValue({ ...receipt, cartReference: input.cartItemReference } as never);
    expect(await f.port.removeItem(input)).toEqual({ status: "Unavailable" });
    expect(f.read).not.toHaveBeenCalled();
  });
  it.each([
    ["CART_PERMISSION_DENIED", "SessionExpired"],
    ["CART_UNAVAILABLE", "NotFound"],
    ["CART_ITEM_NOT_FOUND", "NotFound"],
    ["CART_IDEMPOTENCY_CONFLICT", "IdempotencyConflict"],
    ["CART_EXPIRED", "LifecycleExpired"],
    ["CART_ABANDONED", "LifecycleAbandoned"],
    ["CART_DEPENDENCY_UNAVAILABLE", "Unavailable"],
  ] as const)("maps definitive %s failure", async (code, status) => {
    const f = setup();
    f.remove.mockRejectedValue(new CartError(code));
    expect(await f.port.removeItem(input)).toEqual({ status });
    expect(f.read).not.toHaveBeenCalled();
  });
  it("reports version conflict only from an authorized current view", async () => {
    const f = setup();
    f.remove.mockRejectedValue(new CartError("CART_VERSION_CONFLICT"));
    expect(await f.port.removeItem(input)).toEqual({
      status: "VersionConflict",
      currentVersion: 2,
    });
    f.read.mockRejectedValue(new CartError("CART_PERMISSION_DENIED"));
    expect(await f.port.removeItem(input)).toEqual({ status: "Unavailable" });
  });
  it.each(["createCart", "addItem", "updateItem"] as const)(
    "retains unavailable %s",
    async (method) => {
      const f = setup();
      expect(await f.port[method]({} as never)).toEqual({ status: "Unavailable" });
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.read).not.toHaveBeenCalled();
    },
  );
});
