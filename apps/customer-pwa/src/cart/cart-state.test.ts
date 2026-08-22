import { describe, expect, it } from "vitest";
import type { CustomerCartClient } from "./cart-client.js";
import { createCartStateController } from "./cart-state.js";
import { CartClientError, type CartView } from "./types.js";

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function cart(version = 3): CartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version,
      orderType: "Pickup",
      serviceMode: "Pickup",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-08-02T21:00:00.000Z",
        absoluteExpiresAt: "2026-08-03T20:00:00.000Z",
      },
      items: [
        {
          cartItemReference: id(2),
          sellableReference: id(3),
          displayName: "Synthetic tea",
          quantity: 1,
          configuration: [],
          customerNote: null,
          lineEstimate: {
            status: "Available",
            total: { amountMinor: "500", currency: "CAD" },
          },
          warnings: [],
        },
      ],
      quote: null,
      warnings: [],
    },
  };
}

function fixture() {
  let current: CartView | null = cart();
  let updateFailure: Error | null = null;
  let removeFailure: Error | null = null;
  const calls: { name: string; operationReference?: string }[] = [];
  const client: CustomerCartClient = {
    async loadCurrent() {
      calls.push({ name: "load" });
      return current;
    },
    async createCart() {
      throw new Error("not used by Cart state");
    },
    async addItem() {
      throw new Error("not used by Cart state");
    },
    async updateItem(input) {
      calls.push({ name: "update", operationReference: input.operationReference });
      if (updateFailure !== null) throw updateFailure;
      current = cart(input.cart.cart.version + 1);
      return current;
    },
    async removeItem(input) {
      calls.push({ name: "remove", operationReference: input.operationReference });
      if (removeFailure !== null) throw removeFailure;
      current = { ...cart(input.cart.cart.version + 1), cart: { ...cart().cart, items: [] } };
      return current;
    },
  };
  const controller = createCartStateController({ client, keyFactory: () => id(20) });
  return {
    controller,
    calls,
    failUpdate(error: Error | null) {
      updateFailure = error;
    },
    failRemove(error: Error | null) {
      removeFailure = error;
    },
    setCurrent(value: CartView | null) {
      current = value;
    },
  };
}

describe("WP-1205 in-memory Cart state", () => {
  it("loads server-authoritative ready and empty states", async () => {
    const state = fixture();
    await state.controller.load();
    expect(state.controller.getState()).toMatchObject({ status: "ready", cart: cart() });
    state.setCurrent(null);
    await state.controller.load();
    expect(state.controller.getState()).toEqual({ status: "empty" });
  });

  it("applies a mutation and advances only from the server result", async () => {
    const state = fixture();
    await state.controller.load();
    await state.controller.updateItem(id(2), {
      quantity: 2,
      optionSelections: [],
      customerNote: null,
    });
    expect(state.controller.getState()).toMatchObject({
      status: "ready",
      cart: { cart: { version: 4 } },
    });
    expect(state.calls).toEqual([{ name: "load" }, { name: "update", operationReference: id(20) }]);
  });

  it("coalesces concurrent mutations into one key and one request", async () => {
    let release!: (value: CartView) => void;
    let mutationCalls = 0;
    let keyCalls = 0;
    const gate = new Promise<CartView>((resolve) => {
      release = resolve;
    });
    const client: CustomerCartClient = {
      loadCurrent: async () => cart(),
      createCart: async () => cart(),
      addItem: async () => cart(),
      updateItem: async () => {
        mutationCalls += 1;
        return gate;
      },
      removeItem: async () => {
        mutationCalls += 1;
        return gate;
      },
    };
    const controller = createCartStateController({
      client,
      keyFactory: () => {
        keyCalls += 1;
        return id(20);
      },
    });
    await controller.load();
    const first = controller.updateItem(id(2), {
      quantity: 2,
      optionSelections: [],
      customerNote: null,
    });
    const second = controller.removeItem(id(2));
    expect(second).toBe(first);
    expect({ mutationCalls, keyCalls }).toEqual({ mutationCalls: 1, keyCalls: 1 });
    release(cart(4));
    await Promise.all([first, second]);
  });

  it("retries an unknown foreground outcome with the exact same operation key", async () => {
    const state = fixture();
    await state.controller.load();
    state.failRemove(new CartClientError("network_unknown"));
    await state.controller.removeItem(id(2));
    expect(state.controller.getState()).toMatchObject({
      status: "command-failed",
      canRetrySameOperation: true,
    });
    state.failRemove(null);
    await state.controller.retry();
    expect(state.calls.filter((call) => call.name === "remove")).toEqual([
      { name: "remove", operationReference: id(20) },
      { name: "remove", operationReference: id(20) },
    ]);
  });

  it("refreshes on a Version conflict without replaying the mutation", async () => {
    const state = fixture();
    await state.controller.load();
    state.setCurrent(cart(4));
    state.failUpdate(new CartClientError("cart_version_conflict", { currentVersion: 4 }));
    await state.controller.updateItem(id(2), {
      quantity: 2,
      optionSelections: [],
      customerNote: null,
    });
    expect(state.controller.getState()).toMatchObject({
      status: "conflict",
      cart: { cart: { version: 4 } },
      canRetrySameOperation: false,
    });
    expect(state.calls.map((call) => call.name)).toEqual(["load", "update", "load"]);
  });

  it("never calls or replays a mutation while offline", async () => {
    const state = fixture();
    await state.controller.load();
    state.controller.setOnline(false);
    await state.controller.removeItem(id(2));
    expect(state.controller.getState()).toMatchObject({ status: "offline-readonly" });
    expect(state.calls.map((call) => call.name)).toEqual(["load"]);
    state.controller.setOnline(true);
    expect(state.calls.map((call) => call.name)).toEqual(["load"]);
  });

  it.each([
    ["cart_session_expired", "session-expired"],
    ["cart_not_found", "not-found"],
    ["cart_selection_invalid", "validation"],
    ["cart_rate_limited", "rate-limited"],
    ["cart_expired", "expired"],
    ["cart_abandoned", "abandoned"],
    ["cart_service_unavailable", "unavailable"],
  ] as const)("maps %s without inferring success", async (code, expected) => {
    const state = fixture();
    await state.controller.load();
    state.failUpdate(
      new CartClientError(code, { issueCodes: ["SYNTHETIC_ISSUE"], retryAfterSeconds: 5 }),
    );
    await state.controller.updateItem(id(2), {
      quantity: 2,
      optionSelections: [],
      customerNote: null,
    });
    expect(state.controller.getState()).toMatchObject({ status: expected });
  });
});
