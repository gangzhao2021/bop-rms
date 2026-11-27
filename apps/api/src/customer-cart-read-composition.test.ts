import { describe, expect, it, vi } from "vitest";
import {
  CartError,
  CartParticipationEndedError,
  type CustomerCartDisplayView,
} from "@rms/ordering";
import { EventEmitter } from "node:events";
import { createCustomerCartReadPort } from "./customer-cart-read-composition.js";
import { withRequestAcquireBudget } from "./request-acquire-budget.js";
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
    // Batch 65: a read also reads a table's Cart while it checks out (read-only).
    expect(read).toHaveBeenLastCalledWith({ sessionCredential: credential }, null, {
      atCheckout: true,
    });
    expect(await port.getCart({ ...input, cartReference: reference })).toEqual({
      status: "Found",
      view,
    });
    expect(read).toHaveBeenLastCalledWith(
      { sessionCredential: credential, cartReference: reference },
      null,
      { atCheckout: true },
    );
  });
  // Batch 65 (v15 b64 live): a Cart reloaded after Start checkout named no unsent dish.
  it("a table checking out is still said as such, with its Cart as it is (read-only)", async () => {
    const read = vi.fn(async () => ({ ...view, tableCheckingOut: true as const }));
    const port = createCustomerCartReadPort({ read });
    expect(await port.getCurrentCart(input, "zh-Hans")).toEqual({
      status: "TableCheckingOut",
      view: { schemaVersion: 1, cart: view.cart },
    });
    expect(read).toHaveBeenLastCalledWith({ sessionCredential: credential }, "zh-Hans", {
      atCheckout: true,
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
  it("WP-2423 reads-under-burst: a read the rush turned away is a level-40 wait, read once, and names why", async () => {
    // As v15 logged it on 2026-11-13 (05:46Z), with the Session store now keeping its safe code:
    // the cart's error, the pickup read's, the Session service's passing fault, the store's answer.
    const store = new Error("GUEST_SESSION_UNAVAILABLE");
    Object.defineProperty(store, Symbol.for("bop.failure.cause"), {
      value: Object.freeze({ code: "TENANT_DATABASE_ACQUIRE_FAILED" }),
    });
    const burst = Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
      cause: Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
        cause: Object.assign(new Error("GUEST_SESSION_UNAVAILABLE"), {
          dependencyFailure: true,
          cause: store,
        }),
      }),
    });
    const lines: { level: number; event: string; causes?: string[] }[] = [];
    const log = (event: string, error: unknown, _write: unknown, level: 30 | 40 | 50 = 50) => {
      const causes: string[] = [];
      for (
        let at = (error as { cause?: unknown }).cause;
        at !== undefined && at !== null;
        at =
          (at as { cause?: unknown }).cause ??
          Object.getOwnPropertyDescriptor(at, Symbol.for("bop.failure.cause"))?.value
      )
        causes.push(
          String((at as { code?: unknown; message?: unknown }).code ?? (at as Error).message),
        );
      lines.push({ level, event, causes });
    };
    const pause = vi.fn(async () => undefined);
    // The database noted that this request found no connection within its wait.
    const rushed = vi.fn().mockRejectedValue(burst);
    expect(
      await createCustomerCartReadPort(
        { read: rushed },
        { pause, timeLeftMs: () => 9_000, shed: () => true, log },
      ).getCurrentCart(input),
    ).toEqual({ status: "Unavailable" });
    // Without the request's own note, the kept code alone says there was no connection to give.
    const kept = vi.fn().mockRejectedValue(burst);
    expect(
      await createCustomerCartReadPort(
        { read: kept },
        { pause, timeLeftMs: () => 9_000, shed: () => false, log },
      ).getCurrentCart(input),
    ).toEqual({ status: "Unavailable" });
    expect(rushed).toHaveBeenCalledOnce();
    expect(kept).toHaveBeenCalledOnce();
    expect(pause).not.toHaveBeenCalled();
    expect(lines).toEqual([
      {
        level: 40,
        event: "CUSTOMER_CART_READ_UNAVAILABLE",
        causes: [
          "CART_DEPENDENCY_UNAVAILABLE",
          "GUEST_SESSION_UNAVAILABLE",
          "GUEST_SESSION_UNAVAILABLE",
          "TENANT_DATABASE_ACQUIRE_FAILED",
        ],
      },
      // Not noted as the rush (the database could also be down): a real fault stays level 50.
      expect.objectContaining({ level: 50, event: "CUSTOMER_CART_READ_UNAVAILABLE" }),
    ]);
  });
  it("WP-2423 (rush-reads-and-orders-changes review): a read turned away once that then meets a real fault logs level 50", async () => {
    const levels: number[] = [];
    const log = (_event: string, _error: unknown, _write: unknown, level: 30 | 40 | 50 = 50) => {
      levels.push(level);
    };
    for (const error of [
      // A missing pilot grant under the read's own "unavailable".
      Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
        cause: Object.assign(new Error("TENANT_DATABASE_TRANSACTION_FAILED"), {
          code: "TENANT_DATABASE_TRANSACTION_FAILED",
          diagnostic: { sqlState: "42501" },
        }),
      }),
      // A programming error.
      Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), { cause: new TypeError("x") }),
    ])
      await createCustomerCartReadPort(
        { read: vi.fn().mockRejectedValue(error) },
        { pause: async () => undefined, timeLeftMs: () => 9_000, shed: () => true, log },
      ).getCurrentCart(input);
    expect(levels).toEqual([50, 50]);
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

// WP-2423 (logs-and-transaction-time, v15 2026-11-14): on quiet tables, right after a guest added a
// dish, the phone stopped the cart read it had started; the read was cut and its next connection
// refused at once, and a level-40 CUSTOMER_CART_READ_UNAVAILABLE [TENANT_DATABASE_ACQUIRE_FAILED]
// line followed a completion line that said 200.
describe("logs-and-transaction-time: a cart read whose phone went away", () => {
  const cut = () =>
    Object.assign(new CartError("CART_DEPENDENCY_UNAVAILABLE"), {
      cause: Object.assign(new Error("TENANT_DATABASE_ACQUIRE_FAILED"), {
        code: "TENANT_DATABASE_ACQUIRE_FAILED",
      }),
    });
  const levels = async (leave: boolean, failure: unknown) => {
    const lines: { event: string; level: number }[] = [];
    const log = (event: string, _error: unknown, _write: unknown, level = 50) => {
      lines.push({ event, level });
    };
    const response = Object.assign(new EventEmitter(), { writableFinished: false });
    const result = await withRequestAcquireBudget(
      async () => {
        if (leave) response.emit("close");
        return createCustomerCartReadPort(
          {
            read: async () => {
              throw failure;
            },
          },
          // The database notes the refused connection as the rush (connection-acquire).
          { pause: async () => undefined, shed: () => true, log },
        ).getCurrentCart(input);
      },
      { response, answerWithinMs: 12_000 },
    );
    expect(result).toEqual({ status: "Unavailable" });
    return lines;
  };
  it("is information (level 30): nobody waits for its answer", async () => {
    expect(await levels(true, cut())).toEqual([
      { event: "CUSTOMER_CART_READ_UNAVAILABLE", level: 30 },
    ]);
    // Still listening and turned away by the rush: the wait it is (level 40).
    expect(await levels(false, cut())).toEqual([
      { event: "CUSTOMER_CART_READ_UNAVAILABLE", level: 40 },
    ]);
  });
  it("a real fault it met stays level 50", async () => {
    const denied = Object.assign(new Error("TENANT_DATABASE_TRANSACTION_FAILED"), {
      code: "TENANT_DATABASE_TRANSACTION_FAILED",
      diagnostic: { sqlState: "42501" },
    });
    expect((await levels(true, denied)).map(({ level }) => level)).toEqual([50]);
  });
});
