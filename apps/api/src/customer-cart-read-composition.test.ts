import { describe, expect, it, vi } from "vitest";
import { CartError, type CustomerCartDisplayView } from "@rms/ordering";
import { createCustomerCartReadPort } from "./customer-cart-read-composition.js";
const credential = "a".repeat(43);
const reference = "018f5500-0000-7000-8000-000000000001";
const input = { guestCredential: credential, requestedAt: "2026-09-08T12:00:00.000Z" };
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
describe("Customer Cart read bridge", () => {
  it("forwards only authorization/reference and preserves safe display", async () => {
    const read = vi.fn(async () => view);
    const port = createCustomerCartReadPort({ read });
    expect(Object.isFrozen(port)).toBe(true);
    expect(await port.getCurrentCart(input)).toEqual({ status: "Found", view });
    expect(read).toHaveBeenLastCalledWith({ sessionCredential: credential });
    expect(await port.getCart({ ...input, cartReference: reference })).toEqual({
      status: "Found",
      view,
    });
    expect(read).toHaveBeenLastCalledWith({
      sessionCredential: credential,
      cartReference: reference,
    });
  });
  it("preserves absent current Cart", async () => {
    const port = createCustomerCartReadPort({ read: async () => null });
    expect(await port.getCurrentCart(input)).toEqual({ status: "NotFound" });
    expect(await port.getCart({ ...input, cartReference: reference })).toEqual({
      status: "NotFound",
    });
  });
  it.each([
    [new CartError("CART_PERMISSION_DENIED"), "SessionExpired"],
    [new CartError("CART_INPUT_INVALID"), "Unavailable"],
    [new CartError("CART_DEPENDENCY_UNAVAILABLE"), "Unavailable"],
    [new Error("synthetic restricted payload"), "Unavailable"],
    [{ code: "CART_PERMISSION_DENIED", private: "synthetic" }, "Unavailable"],
  ])("bounds query failures", async (error, status) => {
    const port = createCustomerCartReadPort({
      read: async () => {
        throw error;
      },
    });
    expect(await port.getCurrentCart(input)).toEqual({ status });
  });
  it("WP-2423 guest-cart-503: a table checking out is said as such, plain or as a cause", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      for (const error of [
        new CartError("CART_TABLE_CHECKING_OUT"),
        Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
          cause: new CartError("CART_TABLE_CHECKING_OUT"),
        }),
      ]) {
        const port = createCustomerCartReadPort({
          read: async () => {
            throw error;
          },
        });
        expect(await port.getCurrentCart(input)).toEqual({ status: "TableCheckingOut" });
      }
      expect(write).not.toHaveBeenCalled();
      const left = createCustomerCartReadPort({
        read: async () => {
          throw new CartError("CART_REPLACEMENT_FORBIDDEN");
        },
      });
      expect(await left.getCurrentCart(input)).toEqual({ status: "SessionExpired" });
      const fault = createCustomerCartReadPort({
        read: async () => {
          throw new Error("synthetic fault");
        },
      });
      expect(await fault.getCurrentCart(input)).toEqual({ status: "Unavailable" });
      expect(write).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });
  it("WP-2423 guest-cart-503: matches a second copy of Ordering's CartError by name", async () => {
    class CartError extends Error {
      readonly code = "CART_TABLE_CHECKING_OUT";
      constructor() {
        super("cart is unavailable");
        this.name = "CartError";
      }
    }
    const port = createCustomerCartReadPort({
      read: async () => {
        throw new CartError();
      },
    });
    expect(await port.getCurrentCart(input)).toEqual({ status: "TableCheckingOut" });
  });
  it.each(["createCart", "addItem", "updateItem", "removeItem"] as const)(
    "keeps %s unavailable without invoking reads",
    async (method) => {
      const read = vi.fn(async () => view);
      const port = createCustomerCartReadPort({ read });
      expect(await port[method]({} as never)).toEqual({ status: "Unavailable" });
      expect(read).not.toHaveBeenCalled();
    },
  );
});
