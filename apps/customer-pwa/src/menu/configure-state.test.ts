import { describe, expect, it } from "vitest";
import type { CustomerCartClient } from "../cart/cart-client.js";
import { CartClientError, type CartView } from "../cart/types.js";
import { createConfigureController } from "./configure-state.js";

const id = (n: number) => `018f7600-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function cart(version: number, items: CartView["cart"]["items"] = []): CartView {
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
        idleExpiresAt: "2026-08-12T00:00:00.000Z",
        absoluteExpiresAt: "2026-08-13T00:00:00.000Z",
      },
      items,
      quote: null,
      warnings: [],
    },
  };
}

const addedItem: CartView["cart"]["items"][number] = {
  cartItemReference: id(2),
  sellableReference: id(3),
  displayName: "Synthetic drink",
  quantity: 1,
  configuration: [],
  customerNote: null,
  lineEstimate: { status: "Unavailable", reasonCode: "FINAL_QUOTE_REQUIRED" },
  warnings: [],
};

function fixture(current: CartView | null) {
  const calls: { name: string; key?: string }[] = [];
  let createFailure: Error | null = null;
  let addFailure: Error | null = null;
  const client: CustomerCartClient = {
    async loadCurrent() {
      calls.push({ name: "load" });
      return current;
    },
    async createCart(input) {
      calls.push({ name: "create", key: input.operationReference });
      if (createFailure !== null) throw createFailure;
      current = cart(1);
      return current;
    },
    async addItem(input) {
      calls.push({ name: "add", key: input.operationReference });
      if (addFailure !== null) throw addFailure;
      current = cart(input.cart.cart.version + 1, [addedItem]);
      return current;
    },
    async updateItem() {
      throw new Error("not used by Configurator");
    },
    async removeItem() {
      throw new Error("not used by Configurator");
    },
  };
  const keys = [id(20), id(21)];
  const controller = createConfigureController({
    client,
    keyFactory: () => keys.shift() ?? id(99),
  });
  return {
    calls,
    controller,
    failCreate(value: Error | null) {
      createFailure = value;
    },
    failAdd(value: Error | null) {
      addFailure = value;
    },
  };
}

const draft = Object.freeze({
  quantity: 1,
  optionSelections: Object.freeze([]),
  customerNote: null,
});

describe("WP-1702 in-memory Configurator state", () => {
  it("reuses an existing Cart and applies add only from the advanced server view", async () => {
    const state = fixture(cart(3));
    await state.controller.submit(id(3), draft);
    expect(state.calls).toEqual([{ name: "load" }, { name: "add", key: id(21) }]);
    expect(state.controller.getState()).toMatchObject({
      status: "added",
      cart: { cart: { version: 4 } },
    });
  });

  it("creates an empty Cart and adds with two distinct operation keys", async () => {
    const state = fixture(null);
    await state.controller.submit(id(3), draft);
    expect(state.calls).toEqual([
      { name: "load" },
      { name: "create", key: id(20) },
      { name: "add", key: id(21) },
    ]);
  });

  it("coalesces concurrent submissions before allocating another operation plan", async () => {
    let release!: (value: CartView | null) => void;
    let loadCalls = 0;
    let keyCalls = 0;
    const gate = new Promise<CartView | null>((resolve) => {
      release = resolve;
    });
    const client: CustomerCartClient = {
      loadCurrent: async () => {
        loadCalls += 1;
        return gate;
      },
      createCart: async () => cart(1),
      addItem: async (input) => cart(input.cart.cart.version + 1, [addedItem]),
      updateItem: async () => cart(1),
      removeItem: async () => cart(1),
    };
    const controller = createConfigureController({
      client,
      keyFactory: () => {
        keyCalls += 1;
        return id(20 + keyCalls);
      },
    });
    const first = controller.submit(id(3), draft);
    const second = controller.submit(id(3), draft);
    expect(second).toBe(first);
    expect({ loadCalls, keyCalls }).toEqual({ loadCalls: 1, keyCalls: 2 });
    release(cart(3));
    await Promise.all([first, second]);
  });

  it("retries an unknown create outcome with its exact key before adding", async () => {
    const state = fixture(null);
    state.failCreate(new CartClientError("network_unknown"));
    await state.controller.submit(id(3), draft);
    expect(state.controller.getState()).toMatchObject({
      status: "outcome-unknown",
      canRetry: true,
    });
    state.failCreate(null);
    await state.controller.retry();
    expect(state.calls.filter((call) => call.name === "create")).toEqual([
      { name: "create", key: id(20) },
      { name: "create", key: id(20) },
    ]);
    expect(state.calls.at(-1)).toEqual({ name: "add", key: id(21) });
  });

  it("does not retry server validation and preserves bounded issue codes", async () => {
    const state = fixture(cart(3));
    state.failAdd(
      new CartClientError("cart_selection_invalid", { issueCodes: ["OPTION_CONFLICT"] }),
    );
    await state.controller.submit(id(3), draft);
    expect(state.controller.getState()).toMatchObject({
      status: "validation",
      issueCodes: ["OPTION_CONFLICT"],
      canRetry: false,
    });
  });

  it("never calls or auto-replays a mutation while offline", async () => {
    const state = fixture(cart(3));
    state.controller.setOnline(false);
    await state.controller.submit(id(3), draft);
    expect(state.calls).toEqual([]);
    state.controller.setOnline(true);
    expect(state.calls).toEqual([]);
  });
});
