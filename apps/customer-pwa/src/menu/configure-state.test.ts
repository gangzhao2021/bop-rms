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

describe("Configurator unresolved intent", () => {
  it("pins add payload and version and blocks a superseding submission", async () => {
    const original = cart(3);
    const inputDraft = {
      quantity: 1,
      customerNote: null,
      optionSelections: [{ optionReference: id(4), quantity: 1 }],
    };
    const requests: unknown[] = [];
    let keys = 0;
    const client: CustomerCartClient = {
      loadCurrent: async () => original,
      createCart: async () => cart(1),
      updateItem: async () => cart(1),
      removeItem: async () => cart(1),
      addItem: async (input) => {
        requests.push(structuredClone(input));
        if (requests.length === 1) throw new CartClientError("network_unknown");
        return cart(4, [addedItem]);
      },
    };
    const controller = createConfigureController({ client, keyFactory: () => id(20 + keys++) });
    await controller.submit(id(3), inputDraft);
    inputDraft.quantity = 9;
    Object.assign(inputDraft.optionSelections[0] ?? {}, { quantity: 4 });
    Object.assign(original.cart, { version: 99 });
    await controller.submit(id(8), inputDraft);
    expect(requests).toHaveLength(1);
    expect(keys).toBe(2);
    controller.setOnline(false);
    await controller.retry();
    controller.setOnline(true);
    expect(requests).toHaveLength(1);
    await controller.retry();
    expect(requests[1]).toEqual(requests[0]);
    expect(controller.getState()).toMatchObject({ status: "added" });
  });

  it("does not replace an unknown create and releases a known rejected plan", async () => {
    const state = fixture(null);
    state.failCreate(new CartClientError("network_unknown"));
    await state.controller.submit(id(3), draft);
    await state.controller.submit(id(8), draft);
    expect(state.calls).toEqual([{ name: "load" }, { name: "create", key: id(20) }]);
    state.failCreate(null);
    state.failAdd(new CartClientError("cart_selection_invalid"));
    await state.controller.retry();
    await state.controller.retry();
    expect(state.calls.filter((call) => call.name === "add")).toHaveLength(1);
    state.failAdd(null);
    await state.controller.submit(id(3), draft);
    expect(state.calls.filter((call) => call.name === "add")).toHaveLength(2);
  });

  it("drops an unsent offline submission and permits fresh intent after reconnect", async () => {
    const state = fixture(cart(3));
    state.controller.setOnline(false);
    await state.controller.submit(id(3), draft);
    expect(state.controller.getState()).toEqual({ status: "offline", canRetry: false });
    state.controller.setOnline(true);
    await state.controller.retry();
    expect(state.calls).toEqual([]);
    expect(state.controller.getState()).toEqual({ status: "idle" });
    await state.controller.submit(id(3), draft);
    expect(state.calls).toEqual([{ name: "load" }, { name: "add", key: id(21) }]);
  });

  it("does not infer add success from an unadvanced response", async () => {
    let calls = 0;
    const client: CustomerCartClient = {
      loadCurrent: async () => cart(3),
      createCart: async () => cart(1),
      updateItem: async () => cart(1),
      removeItem: async () => cart(1),
      addItem: async () => {
        calls++;
        return cart(3, [addedItem]);
      },
    };
    const controller = createConfigureController({ client, keyFactory: () => id(20) });
    await controller.submit(id(3), draft);
    await controller.submit(id(3), draft);
    expect(calls).toBe(1);
    expect(controller.getState()).toMatchObject({ status: "outcome-unknown", canRetry: true });
  });
});

it("retains an uncertain add even when its later attempt is rejected", async () => {
  const state = fixture(cart(3));
  state.failAdd(new CartClientError("network_unknown"));
  await state.controller.submit(id(3), draft);
  state.failAdd(new CartClientError("cart_selection_invalid"));
  await state.controller.retry();
  await state.controller.submit(id(3), draft);
  expect(state.calls.filter((call) => call.name === "add")).toHaveLength(2);
  expect(state.controller.getState()).toMatchObject({ status: "outcome-unknown", canRetry: true });
  state.failAdd(null);
  await state.controller.retry();
  expect(state.controller.getState()).toMatchObject({ status: "added" });
});

it("settles an uncertain locate before evaluating a definitive add rejection", async () => {
  let loads = 0;
  let adds = 0;
  const client: CustomerCartClient = {
    loadCurrent: async () => {
      if (++loads === 1) throw new CartClientError("network_unknown");
      return cart(3);
    },
    createCart: async () => cart(1),
    updateItem: async () => cart(1),
    removeItem: async () => cart(1),
    addItem: async () => {
      adds++;
      throw new CartClientError("cart_selection_invalid");
    },
  };
  const controller = createConfigureController({ client, keyFactory: () => id(20) });
  await controller.submit(id(3), draft);
  await controller.retry();
  expect(controller.getState()).toMatchObject({ status: "validation", canRetry: false });
  await controller.submit(id(3), draft);
  expect(adds).toBe(2);
});

it.each(["locate", "create"] as const)(
  "pauses after %s if connectivity changes between foreground stages",
  async (stage) => {
    let release!: (value: CartView | null) => void;
    const gate = new Promise<CartView | null>((resolve) => {
      release = resolve;
    });
    let creates = 0;
    let adds = 0;
    const client: CustomerCartClient = {
      loadCurrent: async () => (stage === "locate" ? gate : null),
      createCart: async () => {
        creates++;
        return stage === "create" ? ((await gate) ?? cart(1)) : cart(1);
      },
      addItem: async () => {
        adds++;
        return cart(2, [addedItem]);
      },
      updateItem: async () => cart(1),
      removeItem: async () => cart(1),
    };
    const controller = createConfigureController({ client, keyFactory: () => id(20) });
    const submit = controller.submit(id(3), draft);
    await Promise.resolve();
    controller.setOnline(false);
    release(stage === "locate" ? null : cart(1));
    await submit;
    expect(creates).toBe(stage === "create" ? 1 : 0);
    expect(adds).toBe(0);
    controller.setOnline(true);
    expect(adds).toBe(0);
    await controller.retry();
    expect(adds).toBe(1);
    expect(creates).toBe(1);
  },
);
