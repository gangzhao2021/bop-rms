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
  let keys = 0;
  const controller = createCartStateController({
    client,
    keyFactory: () => {
      keys++;
      return id(20);
    },
  });
  return {
    controller,
    calls,
    getKeyCount: () => keys,
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
  function foreignCart(): CartView {
    const base = cart();
    return {
      ...base,
      cart: {
        ...base.cart,
        orderType: "DineIn",
        serviceMode: "DineIn",
        items: base.cart.items.map((item) => ({ ...item, warnings: ["OTHER_PARTICIPANT_ITEM"] })),
      },
    };
  }
  it("declines new foreign-item update/remove intents without generating a key", async () => {
    const f = fixture();
    f.setCurrent(foreignCart());
    await f.controller.load();
    await f.controller.updateItem(id(2), { quantity: 2, optionSelections: [], customerNote: null });
    await f.controller.removeItem(id(2));
    expect(f.calls).toEqual([{ name: "load" }]);
    expect(f.getKeyCount()).toBe(0);
    expect(f.controller.getState()).toEqual({ status: "ready", cart: foreignCart() });
  });
  it("preserves explicit original recovery despite a later foreign-item display", async () => {
    const f = fixture();
    await f.controller.load();
    f.failUpdate(new CartClientError("network_unknown"));
    await f.controller.updateItem(id(2), { quantity: 2, optionSelections: [], customerNote: null });
    f.setCurrent(foreignCart());
    await f.controller.load();
    expect(f.controller.getState()).toMatchObject({
      status: "command-failed",
      canRetrySameOperation: true,
    });
    f.failUpdate(null);
    await f.controller.retry();
    expect(f.calls.filter((call) => call.name === "update")).toEqual([
      { name: "update", operationReference: id(20) },
      { name: "update", operationReference: id(20) },
    ]);
    expect(f.getKeyCount()).toBe(1);
  });
  it("does not queue or replay foreign-item intents offline", async () => {
    const f = fixture();
    f.setCurrent(foreignCart());
    await f.controller.load();
    f.controller.setOnline(false);
    await f.controller.removeItem(id(2));
    f.controller.setOnline(true);
    await f.controller.retry();
    expect(f.calls).toEqual([{ name: "load" }]);
    expect(f.getKeyCount()).toBe(0);
  });

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

describe("retained foreground Cart intent", () => {
  it.each(["update", "remove"] as const)(
    "pins %s through unknown, refresh, caller edits and reconnect",
    async (kind) => {
      const original = cart();
      const draft = {
        quantity: 2,
        customerNote: null,
        optionSelections: [{ optionReference: id(4), quantity: 1 }],
      };
      const requests: unknown[] = [];
      let reject = true;
      let keyCount = 0;
      let loads = 0;
      const mutate = async (
        input:
          | Parameters<CustomerCartClient["updateItem"]>[0]
          | Parameters<CustomerCartClient["removeItem"]>[0],
      ) => {
        requests.push(structuredClone(input));
        if (reject) throw new CartClientError("network_unknown");
        return cart(4);
      };
      const client: CustomerCartClient = {
        loadCurrent: async () => (++loads === 1 ? original : cart(9)),
        createCart: async () => cart(),
        addItem: async () => cart(),
        updateItem: mutate,
        removeItem: mutate,
      };
      const controller = createCartStateController({
        client,
        keyFactory: () => id(20 + keyCount++),
      });
      await controller.load();
      if (kind === "update") await controller.updateItem(id(2), draft);
      else await controller.removeItem(id(2));
      draft.quantity = 7;
      Object.assign(draft.optionSelections[0] ?? {}, { quantity: 3 });
      Object.assign(original.cart, { version: 90 });
      await controller.load();
      expect(controller.getState()).toMatchObject({
        status: "command-failed",
        cart: { cart: { version: 9 } },
        canRetrySameOperation: true,
      });
      await controller.updateItem(id(2), draft);
      await controller.removeItem(id(2));
      expect(requests).toHaveLength(1);
      expect(keyCount).toBe(1);
      controller.setOnline(false);
      await controller.retry();
      controller.setOnline(true);
      expect(requests).toHaveLength(1);
      expect(controller.getState()).toMatchObject({
        status: "command-failed",
        canRetrySameOperation: true,
      });
      reject = false;
      await controller.retry();
      expect(requests).toHaveLength(2);
      expect(requests[1]).toEqual(requests[0]);
      expect(requests[1]).toMatchObject({
        cart: { cart: { version: 3 } },
        operationReference: id(20),
      });
      expect(controller.getState()).toMatchObject({ status: "ready" });
      await controller.removeItem(id(2));
      expect(keyCount).toBe(2);
    },
  );

  it("does not allow a late refresh to overwrite a completed retry", async () => {
    let release!: (value: CartView | null) => void;
    let loads = 0;
    let calls = 0;
    const client: CustomerCartClient = {
      loadCurrent: async () =>
        ++loads === 1
          ? cart()
          : new Promise((resolve) => {
              release = resolve;
            }),
      createCart: async () => cart(),
      addItem: async () => cart(),
      updateItem: async () => cart(),
      removeItem: async () => {
        if (++calls === 1) throw new CartClientError("network_unknown");
        return cart(4);
      },
    };
    const controller = createCartStateController({ client, keyFactory: () => id(20) });
    await controller.load();
    await controller.removeItem(id(2));
    const refresh = controller.load();
    await controller.retry();
    release(cart(3));
    await refresh;
    expect(controller.getState()).toMatchObject({
      status: "ready",
      cart: { cart: { version: 4 } },
    });
  });

  it("allocates no offline intent and allows reviewed input after a known rejection", async () => {
    const state = fixture();
    await state.controller.load();
    state.controller.setOnline(false);
    await state.controller.removeItem(id(2));
    state.controller.setOnline(true);
    await state.controller.retry();
    expect(state.calls).toEqual([{ name: "load" }]);
    await state.controller.load();
    state.failRemove(new CartClientError("cart_selection_invalid"));
    await state.controller.removeItem(id(2));
    await state.controller.retry();
    expect(state.calls.filter((call) => call.name === "remove")).toHaveLength(1);
    state.failRemove(null);
    await state.controller.removeItem(id(2));
    expect(state.calls.filter((call) => call.name === "remove")).toHaveLength(2);
  });
});

it("does not treat a later rejection as proof an earlier Cart command failed", async () => {
  const state = fixture();
  await state.controller.load();
  state.failRemove(new CartClientError("network_unknown"));
  await state.controller.removeItem(id(2));
  state.failRemove(new CartClientError("cart_session_expired"));
  await state.controller.retry();
  await state.controller.removeItem(id(2));
  expect(state.calls.filter((call) => call.name === "remove")).toHaveLength(2);
  expect(state.controller.getState()).toMatchObject({
    status: "command-failed",
    canRetrySameOperation: true,
  });
  state.failRemove(null);
  await state.controller.retry();
  expect(state.calls.filter((call) => call.name === "remove")).toHaveLength(3);
});
