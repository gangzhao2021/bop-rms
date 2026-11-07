import {
  getGuestTableJoiner,
  getGuestTableStarter,
  setCustomerCsrfCredential,
  setGuestTableJoiner,
  setGuestTableQuestion,
  setGuestTableStarter,
  setUnseatedTableScan,
  type GuestTableStartAnswer,
} from "../session/customer-transaction-context.js";
import { describe, expect, it } from "vitest";
import type { CustomerCartClient } from "../cart/cart-client.js";
import { CartClientError, type CartView } from "../cart/types.js";
import { createConfigureController } from "./configure-state.js";
import { cartText } from "../journey/messages.js";

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

  it("tells a phone not seated at its table yet that it orders once seated", async () => {
    const state = fixture(null);
    state.failCreate(new CartClientError("cart_dining_not_seated"));
    await state.controller.submit(id(3), draft);
    expect(state.controller.getState()).toMatchObject({ status: "not-seated" });
  });

  it("M126 I.2: tells a phone no longer at its table why, never that its visit expired", async () => {
    const state = fixture(null);
    state.failCreate(new CartClientError("cart_participant_ended"));
    await state.controller.submit(id(3), draft);
    expect(state.controller.getState()).toMatchObject({ status: "participation-ended" });
  });
  it("sends nothing from a phone that scanned a table no party is seated at", async () => {
    setUnseatedTableScan(true);
    setCustomerCsrfCredential(null);
    try {
      const state = fixture(null);
      await state.controller.submit(id(3), draft);
      expect(state.controller.getState()).toMatchObject({ status: "not-seated" });
      expect(state.calls).toEqual([]);
    } finally {
      setUnseatedTableScan(false);
    }
  });

  it("DEC-DINING-GUEST-TABLE-START: a phone asked whether it's with the people there answers that first", async () => {
    setUnseatedTableScan(true);
    setCustomerCsrfCredential(null);
    setGuestTableQuestion(true);
    try {
      const state = fixture(null);
      await state.controller.submit(id(3), draft);
      expect(state.controller.getState()).toMatchObject({ status: "table-question" });
      expect(state.calls).toEqual([]);
    } finally {
      setGuestTableQuestion(false);
      setUnseatedTableScan(false);
    }
  });

  it("DEC-DINING-GUEST-TABLE-START: a start whose join was refused is joined again on the next Add, never sent to staff", async () => {
    setUnseatedTableScan(true);
    setCustomerCsrfCredential(null);
    let joinRefused = true;
    const joins: string[] = [];
    // As the start page does: the start lets this phone in (a new visit clears the starter), the
    // table's joins are spent, so it leaves a starter that only joins.
    const join = async (): Promise<GuestTableStartAnswer> => {
      joins.push("join");
      if (joinRefused) {
        setGuestTableStarter(join);
        return "Refused";
      }
      setCustomerCsrfCredential("csrf-joined");
      return "Started";
    };
    setGuestTableStarter(async () => {
      setCustomerCsrfCredential("csrf-started");
      return join();
    });
    try {
      const state = fixture(null);
      await state.controller.submit(id(3), draft);
      expect(state.controller.getState()).toMatchObject({ status: "table-start-refused" });
      expect(state.calls).toEqual([]);
      // The guest taps Add again a minute later: the join is tried, not the cart.
      joinRefused = false;
      await state.controller.submit(id(3), draft);
      expect(joins).toEqual(["join", "join"]);
      expect(state.controller.getState()).not.toMatchObject({ status: "not-seated" });
      expect(state.calls.map((call) => call.name)).toEqual(["load", "create", "add"]);
      expect(getGuestTableStarter()).toBeNull();
    } finally {
      setGuestTableStarter(null);
      setCustomerCsrfCredential(null);
      setUnseatedTableScan(false);
    }
  });

  it("M115: at an open table this phone browsed first, the tap on Add joins the table and adds the dish", async () => {
    // The scan's entry already gave this phone a CSRF credential (for the table, not a place at it).
    setCustomerCsrfCredential("csrf-entry");
    let refuse = true;
    const joins: string[] = [];
    setGuestTableJoiner(async (): Promise<GuestTableStartAnswer> => {
      joins.push("join");
      if (refuse) return "Refused";
      setCustomerCsrfCredential("csrf-joined");
      setGuestTableJoiner(null);
      return "Started";
    });
    try {
      const state = fixture(null);
      await state.controller.submit(id(3), draft);
      // Refused: said as a join, never "staff will seat you"; nothing sent; the dish is kept.
      expect(state.controller.getState()).toMatchObject({ status: "table-join-refused" });
      expect(state.calls).toEqual([]);
      refuse = false;
      await state.controller.submit(id(3), draft);
      expect(joins).toEqual(["join", "join"]);
      expect(state.calls.map((call) => call.name)).toEqual(["load", "create", "add"]);
      expect(state.controller.getState()).toMatchObject({ status: "added" });
      expect(getGuestTableJoiner()).toBeNull();
    } finally {
      setGuestTableJoiner(null);
      setCustomerCsrfCredential(null);
    }
  });

  it("M115: after a reload (no join in memory) a not-joined phone at an open table is sent to join it, not to staff", () => {
    setGuestTableJoiner(null);
    setUnseatedTableScan(false);
    expect(cartText.failure.notSeated).toEqual([
      "Join this table first",
      "Join this table to order and see what your table has ordered.",
    ]);
    // A table nobody is seated at still says staff seat the party.
    setUnseatedTableScan(true);
    try {
      expect(cartText.failure.notSeated[0]).toBe("You can order once staff seat you");
    } finally {
      setUnseatedTableScan(false);
    }
  });

  it("DEC-DINING-GUEST-TABLE-START: people sat down at the table first: the guest is sent back to join them", async () => {
    setUnseatedTableScan(true);
    setCustomerCsrfCredential(null);
    setGuestTableStarter(async () => "InUse");
    try {
      const state = fixture(null);
      await state.controller.submit(id(3), draft);
      expect(state.controller.getState()).toMatchObject({ status: "table-in-use" });
      expect(state.calls).toEqual([]);
    } finally {
      setGuestTableStarter(null);
      setUnseatedTableScan(false);
    }
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

describe("WP-2423: continuing past a timed-out table cart", () => {
  const draft = { quantity: 1, customerNote: null, optionSelections: [] };
  function client(script: {
    current?: CartView | null;
    create: (() => CartView | Error)[];
    add: (() => Error | null)[];
  }) {
    const calls: { name: string; key?: string }[] = [];
    let current = script.current ?? null;
    const waits: number[] = [];
    const value: CustomerCartClient = {
      async loadCurrent() {
        calls.push({ name: "load" });
        return current;
      },
      async createCart(input) {
        calls.push({ name: "create", key: input.operationReference });
        const next = script.create.shift()?.() ?? cart(1);
        if (next instanceof Error) throw next;
        current = next;
        return next;
      },
      async addItem(input) {
        calls.push({ name: "add", key: input.operationReference });
        const failure = script.add.shift()?.() ?? null;
        if (failure !== null) throw failure;
        current = cart(input.cart.cart.version + 1, [addedItem]);
        return current;
      },
      async updateItem() {
        throw new Error("unused");
      },
      async removeItem() {
        throw new Error("unused");
      },
    };
    let n = 30;
    const controller = createConfigureController({
      client: value,
      keyFactory: () => id(n++),
      wait: async (ms) => {
        waits.push(ms);
      },
    });
    return { calls, controller, waits };
  }
  it("tells the guest once when the earlier table cart's unordered items were cleared", async () => {
    const replaced = cart(1);
    const f = client({
      create: [
        () => ({
          ...replaced,
          cart: { ...replaced.cart, warnings: ["EARLIER_CART_ITEMS_CLEARED"] },
        }),
      ],
      add: [],
    });
    await f.controller.submit(id(3), draft);
    expect(f.controller.getState()).toMatchObject({ status: "added", earlierCartCleared: true });
    const g = client({ create: [], add: [] });
    await g.controller.submit(id(3), draft);
    const state = g.controller.getState();
    expect(state.status).toBe("added");
    expect("earlierCartCleared" in state).toBe(false);
  });
  it("retries cart creation once after the server's short pause, with the same operation", async () => {
    const f = client({
      create: [
        () => new CartClientError("cart_service_unavailable", { retryAfterSeconds: 5 }),
        () => cart(1),
      ],
      add: [],
    });
    await f.controller.submit(id(3), draft);
    expect(f.waits).toEqual([5000]);
    const creates = f.calls.filter((call) => call.name === "create");
    expect(creates).toHaveLength(2);
    expect(creates[0]?.key).toBe(creates[1]?.key);
    expect(f.controller.getState().status).toBe("added");
    // A second refusal is reported, not retried forever.
    const g = client({
      create: [
        () => new CartClientError("cart_service_unavailable", { retryAfterSeconds: 5 }),
        () => new CartClientError("cart_service_unavailable", { retryAfterSeconds: 5 }),
      ],
      add: [],
    });
    await g.controller.submit(id(3), draft);
    expect(g.waits).toHaveLength(1);
    expect(g.controller.getState().status).toBe("unavailable");
    // Without a retry hint nothing is retried automatically.
    const h = client({ create: [() => new CartClientError("cart_service_unavailable")], add: [] });
    await h.controller.submit(id(3), draft);
    expect(h.waits).toEqual([]);
  });
  it("starts again once with new operations when the cart times out right before the add", async () => {
    const f = client({
      current: cart(4),
      create: [],
      add: [() => new CartClientError("cart_expired")],
    });
    await f.controller.submit(id(3), draft);
    expect(f.calls.map((call) => call.name)).toEqual(["load", "add", "load", "add"]);
    const adds = f.calls.filter((call) => call.name === "add");
    expect(adds[0]?.key).not.toBe(adds[1]?.key);
    expect(f.controller.getState().status).toBe("added");
    // A second timeout is reported with the plain-language expired state.
    const g = client({
      current: cart(4),
      create: [],
      add: [() => new CartClientError("cart_expired"), () => new CartClientError("cart_expired")],
    });
    await g.controller.submit(id(3), draft);
    expect(g.controller.getState().status).toBe("expired");
  });
  it("M99: adds again from the current cart with a new operation when someone else changed it first", async () => {
    // Staff saved the party size (the tea charge) between this phone's read and its add.
    const f = client({
      current: cart(4),
      create: [],
      add: [() => new CartClientError("cart_version_conflict")],
    });
    await f.controller.submit(id(3), draft);
    expect(f.calls.map((call) => call.name)).toEqual(["load", "add", "load", "add"]);
    const adds = f.calls.filter((call) => call.name === "add");
    expect(adds[0]?.key).not.toBe(adds[1]?.key);
    expect(f.waits).toHaveLength(1);
    expect(f.waits[0]).toBeGreaterThanOrEqual(150);
    expect(f.waits[0]).toBeLessThanOrEqual(400);
    expect(f.controller.getState().status).toBe("added");
  });
  it("M99: tries at most twice more, then says the cart changed", async () => {
    const conflict = () => new CartClientError("cart_version_conflict");
    const f = client({ current: cart(4), create: [], add: [conflict, conflict, conflict] });
    await f.controller.submit(id(3), draft);
    expect(f.calls.filter((call) => call.name === "add")).toHaveLength(3);
    expect(f.controller.getState().status).toBe("conflict");
    // An idempotency conflict (the same operation with other content) is never retried.
    const g = client({
      current: cart(4),
      create: [],
      add: [() => new CartClientError("cart_idempotency_conflict")],
    });
    await g.controller.submit(id(3), draft);
    expect(g.calls.filter((call) => call.name === "add")).toHaveLength(1);
    expect(g.controller.getState().status).toBe("conflict");
  });
});

it("WP-2423: waits once for the table's last order, then says it is still being processed", async () => {
  const calls: string[] = [];
  const waits: number[] = [];
  let creates = 0;
  const client: CustomerCartClient = {
    async loadCurrent() {
      calls.push("load");
      return null;
    },
    async createCart() {
      calls.push("create");
      creates += 1;
      throw new CartClientError("cart_order_processing", { retryAfterSeconds: 10 });
    },
    async addItem() {
      throw new Error("unused");
    },
    async updateItem() {
      throw new Error("unused");
    },
    async removeItem() {
      throw new Error("unused");
    },
  };
  let n = 60;
  const controller = createConfigureController({
    client,
    keyFactory: () => id(n++),
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  await controller.submit(id(3), { quantity: 1, customerNote: null, optionSelections: [] });
  expect(waits).toEqual([10000]);
  expect(creates).toBe(2);
  expect(controller.getState()).toMatchObject({ status: "order-processing", canRetry: false });
});

it("WP-2423: does not auto-retry while another guest is checking out, and allows a new add", async () => {
  const state = fixture(cart(3));
  state.failAdd(new CartClientError("cart_checkout_in_progress", { retryAfterSeconds: 45 }));
  await state.controller.submit(id(3), draft);
  expect(state.controller.getState()).toMatchObject({
    status: "checkout-in-progress",
    retryAfterSeconds: 45,
    canRetry: false,
  });
  expect(state.calls.filter((call) => call.name === "add")).toHaveLength(1);
  state.failAdd(null);
  await state.controller.submit(id(3), draft);
  expect(state.controller.getState()).toMatchObject({ status: "added" });
});
