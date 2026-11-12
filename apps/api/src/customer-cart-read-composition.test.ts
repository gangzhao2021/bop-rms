import { describe, expect, it, vi } from "vitest";
import {
  CartError,
  CartParticipationEndedError,
  type CustomerCartDisplayView,
} from "@rms/ordering";
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
    placedOrder: null,
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
  it("reads once more after a passing fault (staff moving the table), never in a rush or late", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const midChange = Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
        cause: Object.assign(new Error("GUEST_SESSION_UNAVAILABLE"), { dependencyFailure: true }),
      });
      const pauses: number[] = [];
      const pause = async (ms: number) => void pauses.push(ms);
      const read = vi.fn().mockRejectedValueOnce(midChange).mockResolvedValueOnce(view);
      const moved = createCustomerCartReadPort({ read }, { pause, timeLeftMs: () => 9_000 });
      expect(await moved.getCurrentCart(input)).toEqual({ status: "Found", view });
      expect(read).toHaveBeenCalledTimes(2);
      expect(pauses).toEqual([200]);
      // The guest never saw it, but the first failure is still on record (level 40, below).
      expect(write).toHaveBeenCalledOnce();
      // No connection to be had: reading again would only add to the rush.
      const busy = Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
        cause: Object.assign(new Error("acquire"), { code: "TENANT_DATABASE_ACQUIRE_FAILED" }),
      });
      const rush = vi.fn().mockRejectedValue(busy);
      expect(
        await createCustomerCartReadPort({ read: rush }, { pause }).getCurrentCart(input),
      ).toEqual({ status: "Unavailable" });
      expect(rush).toHaveBeenCalledOnce();
      // Too little of the read's time left to answer after another read.
      const late = vi.fn().mockRejectedValue(midChange);
      expect(
        await createCustomerCartReadPort(
          { read: late },
          { pause, timeLeftMs: () => 2_000 },
        ).getCurrentCart(input),
      ).toEqual({ status: "Unavailable" });
      expect(late).toHaveBeenCalledOnce();
      // Twice in a row: told busy, once logged.
      const twice = vi.fn().mockRejectedValue(midChange);
      expect(
        await createCustomerCartReadPort({ read: twice }, { pause }).getCurrentCart(input),
      ).toEqual({ status: "Unavailable" });
      expect(twice).toHaveBeenCalledTimes(2);
      // A refusal answers the same every time: no second read.
      const refused = vi.fn().mockRejectedValue(new CartError("CART_INPUT_INVALID"));
      expect(
        await createCustomerCartReadPort({ read: refused }, { pause }).getCurrentCart(input),
      ).toEqual({ status: "Unavailable" });
      expect(refused).toHaveBeenCalledOnce();
      expect(pauses).toEqual([200, 200]);
      // The swallowed first failure is kept at level 40 with its cause codes only.
      const lines = write.mock.calls.map(([line]) => JSON.parse(String(line)) as object);
      expect(lines).toEqual([
        expect.objectContaining({
          level: 40,
          event: "CUSTOMER_CART_READ_RETRIED",
          code: "CART_DEPENDENCY_UNAVAILABLE",
          causes: ["GUEST_SESSION_UNAVAILABLE"],
        }),
        expect.objectContaining({ level: 50, event: "CUSTOMER_CART_READ_UNAVAILABLE" }),
        expect.objectContaining({ level: 50, event: "CUSTOMER_CART_READ_UNAVAILABLE" }),
        expect.objectContaining({ level: 40, event: "CUSTOMER_CART_READ_RETRIED" }),
        expect.objectContaining({ level: 50, event: "CUSTOMER_CART_READ_UNAVAILABLE" }),
        expect.objectContaining({
          level: 50,
          event: "CUSTOMER_CART_READ_UNAVAILABLE",
          code: "CART_INPUT_INVALID",
        }),
      ]);
      for (const [line] of write.mock.calls)
        expect(String(line)).not.toMatch(/sessionCredential|cartReference/u);
    } finally {
      write.mockRestore();
    }
  });
  it("M126 I.2: a phone whose place at the table ended reads why, plain or as a cause", async () => {
    for (const error of [
      new CartParticipationEndedError("TableClosed"),
      Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
        cause: new CartParticipationEndedError("TableClosed"),
      }),
    ]) {
      const port = createCustomerCartReadPort({
        read: async () => {
          throw error;
        },
      });
      expect(await port.getCurrentCart(input)).toEqual({
        status: "ParticipationEnded",
        reason: "TableClosed",
      });
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
