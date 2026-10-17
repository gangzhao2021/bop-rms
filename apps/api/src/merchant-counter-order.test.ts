import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the merchant session lookup and the two owner-record readers are doubles; the command's
// own sequencing, idempotency and error mapping are the real code.
const state = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
  orders: new Map<string, Record<string, unknown>>(),
  // The full caller resolution (Session, selection, membership, permission policy).
  allowed: { fn: async (): Promise<boolean> => true, calls: 0 },
  // What the owner callbacks answered during and after each run.
  guards: [] as (() => Promise<boolean>)[],
  during: [] as boolean[],
  rolledBack: 0,
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async () => ({
    selected: { tenantReference: "0198a7c0-0000-7000-8000-000000000001" },
    context: { brand: { brandReference: "0198a7c0-0000-7000-8000-000000000002" } },
    store: { storeReference: "0198a7c0-0000-7000-8000-000000000003" },
    actorReference: "0198a7c0-0000-7000-8000-000000000004",
    allowed: async () => {
      state.allowed.calls++;
      return state.allowed.fn();
    },
  }),
}));
vi.mock("./counter-payment-preparation.js", () => ({
  readCounterPaymentPreparation: async (_tx: unknown, owner: { authorize(): Promise<boolean> }) => {
    state.guards.push(owner.authorize);
    state.during.push(await owner.authorize());
    return {
      preparation: {
        orderAllocation: { amountMinor: 1130n },
        tip: { amountMinor: 150n },
        total: { amountMinor: 1280n },
        capacityExpiresAt: "2026-10-13T18:30:00.000Z",
      },
      orderNumber: "12",
      orderVersion: 1,
      paymentOperationReference: "0198a7c0-0000-7000-8000-000000000099",
    };
  },
}));
vi.mock("@rms/ordering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/ordering")>();
  return {
    ...actual,
    createPostgresCounterOrderEntryStore: (owner: { authorize(): Promise<boolean> }) => ({
      loadByOperation: async (_tx: unknown, operation: string) => {
        state.guards.push(owner.authorize);
        state.during.push(await owner.authorize());
        return state.entries.get(operation) ?? null;
      },
      record: async (_tx: unknown, value: Record<string, unknown>) => {
        state.during.push(await owner.authorize());
        const key = String(value.operationReference);
        const prior = state.entries.get(key);
        if (prior) return { status: "AlreadyRecorded", record: prior };
        state.entries.set(key, value);
        return { status: "Created", record: value };
      },
      loadOrder: async (_tx: unknown, cart: string) => state.orders.get(cart) ?? null,
    }),
  };
});

const { createMerchantCounterOrder } = await import("./merchant-counter-order.js");

const id = (n: number) => `0198a7c0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const guest = { sessionCredential: "a".repeat(43), csrfCredential: "b".repeat(43) };

function setup(clock = { at: "2026-10-13T18:00:00.000Z" }) {
  let sequence = 0x100;
  const calls: string[] = [];
  const pipeline = {
    takesOrder: vi.fn(async (input: { recordedAfterOutage: boolean }) => {
      calls.push("takesOrder");
      return typeof input.recordedAfterOutage === "boolean";
    }),
    open: vi.fn(async () => {
      calls.push("open");
      return { status: "Established" as const, credentials: guest };
    }),
    bindCart: vi.fn(async () => {
      calls.push("bindCart");
      return {
        credentials: guest,
        guestSessionReference: id(5),
        cartReference: id(6),
        cartVersion: 1,
      };
    }),
    addItem: vi.fn(async () => {
      calls.push("addItem");
      return { status: "Applied" as const, cartVersion: 2 };
    }),
    quote: vi.fn(async () => {
      calls.push("quote");
      return {
        status: "Quoted" as const,
        quoteReference: id(7),
        subtotalMinor: 1000n,
        totalMinor: 1130n,
      };
    }),
    saveDetails: vi.fn(async () => {
      calls.push("saveDetails");
    }),
    startCheckout: vi.fn(async () => {
      calls.push("startCheckout");
      return { status: "Started" as const, checkoutSessionReference: id(8) };
    }),
    preparePayment: vi.fn(async (_c: unknown, input: { tip: { amountMinor: bigint } }) => {
      calls.push("preparePayment");
      state.orders.set(id(6), {
        orderReference: id(20),
        orderBatchReference: id(21),
        submissionReference: id(22),
      });
      return { tip: { amountMinor: input.tip.amountMinor } } as never;
    }),
  };
  const onUnexpected = vi.fn();
  const command = createMerchantCounterOrder({
    persistence: {
      transactions: {
        run: async (work: (tx: unknown) => Promise<unknown>) => {
          try {
            return await work({});
          } catch (error) {
            state.rolledBack++;
            throw error;
          }
        },
      },
      now: () => clock.at,
    } as never,
    authentication: { authorize: async () => ({ sessionReference: id(9) }) } as never,
    pipeline,
    nextReference: () => id(++sequence),
    onUnexpected,
  });
  const send = (overrides: Record<string, unknown> = {}) =>
    command({
      sessionCookie: "cookie",
      csrf: "csrf",
      command: {
        operationReference: id(1),
        lines: [{ sellableReference: id(2), quantity: 1, optionSelections: [] }],
        tip: { kind: "Percent", percent: 15 },
        recordedAfterOutage: false,
        ...overrides,
      },
    });
  return { pipeline, calls, onUnexpected, send, clock };
}

describe("counter order command — WP-2423 Q7", () => {
  beforeEach(() => {
    state.entries.clear();
    state.orders.clear();
    state.allowed = { fn: async () => true, calls: 0 };
    state.guards = [];
    state.during = [];
    state.rolledBack = 0;
  });

  it("saves the pickup checkout details before checkout, as every pickup Order needs", async () => {
    const { calls, send, pipeline } = setup();
    const placed = await send();
    expect(placed).toMatchObject({ status: "Placed", totalMinor: "1280", orderNumber: "12" });
    expect(calls).toEqual([
      "takesOrder",
      "open",
      "bindCart",
      "addItem",
      "quote",
      "saveDetails",
      "startCheckout",
      "preparePayment",
    ]);
    expect(pipeline.saveDetails).toHaveBeenCalledWith(
      guest,
      expect.objectContaining({ cartReference: id(6), cartVersion: 2, quoteReference: id(7) }),
    );
    expect(pipeline.preparePayment).toHaveBeenCalledWith(
      guest,
      expect.objectContaining({ recordedAfterOutage: false }),
    );
    expect(await send()).toMatchObject({ status: "AlreadyPlaced", orderReference: id(20) });
    expect(pipeline.open).toHaveBeenCalledTimes(1);
  });

  it("asks the counter rule (not the online pause) before opening a guest", async () => {
    const { pipeline, send } = setup();
    pipeline.takesOrder.mockResolvedValueOnce(false);
    await expect(send()).rejects.toMatchObject({ code: "COUNTER_ORDER_STORE_NOT_TAKING_ORDERS" });
    expect(pipeline.open).not.toHaveBeenCalled();
    await send({ operationReference: id(30), recordedAfterOutage: true });
    expect(pipeline.takesOrder).toHaveBeenLastCalledWith({ recordedAfterOutage: true });
  });

  it("tells staff an unfinished send is still running, then lets them start over", async () => {
    const clock = { at: "2026-10-13T18:00:00.000Z" };
    const { pipeline, send, onUnexpected } = setup(clock);
    const failure = Object.assign(new Error("ORDER_CREATE_UNAVAILABLE"), {
      code: "ORDER_CREATE_UNAVAILABLE",
    });
    pipeline.preparePayment.mockRejectedValueOnce(failure);
    await expect(send()).rejects.toMatchObject({ code: "COUNTER_ORDER_UNAVAILABLE" });
    // The original error reaches the log hook; staff only get "try again".
    expect(onUnexpected).toHaveBeenCalledWith(failure);
    await expect(send()).rejects.toMatchObject({ code: "COUNTER_ORDER_IN_PROGRESS" });
    clock.at = "2026-10-13T18:02:01.000Z";
    await expect(send()).rejects.toMatchObject({ code: "COUNTER_ORDER_NOT_FINISHED" });
    // A new send is a new order; the failed attempt opened no second guest on retry.
    expect(pipeline.open).toHaveBeenCalledTimes(1);
    expect(await send({ operationReference: id(31) })).toMatchObject({ status: "Placed" });
  });

  it("does not log business refusals", async () => {
    const { pipeline, send, onUnexpected } = setup();
    pipeline.addItem.mockResolvedValueOnce({ status: "NotAvailable" } as never);
    await expect(send()).rejects.toMatchObject({
      code: "COUNTER_ORDER_ITEM_UNAVAILABLE",
      lineIndex: 0,
    });
    expect(onUnexpected).not.toHaveBeenCalled();
  });

  describe("v15 run: an item with too little stock", () => {
    const stockOf = (left: number) =>
      vi.fn(async (_c: unknown, input: { quantity: number }) => input.quantity <= left);
    const twoLines = {
      lines: [
        { sellableReference: id(2), quantity: 1, optionSelections: [] },
        { sellableReference: id(3), quantity: 1, optionSelections: [] },
        { sellableReference: id(2), quantity: 1, optionSelections: [] },
      ],
    };

    it("names the item and how many are left when the same item on several lines is short", async () => {
      const { pipeline, send, onUnexpected } = setup();
      const canSell = stockOf(1);
      Object.assign(pipeline, { canSell });
      await expect(send(twoLines)).rejects.toMatchObject({
        code: "COUNTER_ORDER_STOCK_SHORT",
        lineIndex: 0,
        available: 1,
      });
      // Checked as the walk-up guest against its Cart, for both lines together.
      expect(canSell).toHaveBeenCalledWith(
        guest,
        expect.objectContaining({
          cartReference: id(6),
          cartVersion: 2,
          sellableReference: id(2),
          quantity: 2,
        }),
      );
      // Nothing was priced, checked out or charged; it is a business answer, not an outage.
      expect(pipeline.quote).not.toHaveBeenCalled();
      expect(pipeline.startCheckout).not.toHaveBeenCalled();
      expect(onUnexpected).not.toHaveBeenCalled();
    });

    it("finds how many are left when a line's own quantity is refused", async () => {
      const { pipeline, send } = setup();
      Object.assign(pipeline, { canSell: stockOf(3) });
      pipeline.addItem.mockResolvedValueOnce({ status: "NotAvailable" } as never);
      await expect(
        send({ lines: [{ sellableReference: id(2), quantity: 7, optionSelections: [] }] }),
      ).rejects.toMatchObject({ code: "COUNTER_ORDER_STOCK_SHORT", lineIndex: 0, available: 3 });
    });

    it("keeps the sold-out answer when none can be sold, and places a covered order", async () => {
      const { pipeline, send } = setup();
      Object.assign(pipeline, { canSell: stockOf(0) });
      pipeline.addItem.mockResolvedValueOnce({ status: "NotAvailable" } as never);
      await expect(send()).rejects.toMatchObject({
        code: "COUNTER_ORDER_ITEM_UNAVAILABLE",
        lineIndex: 0,
      });
      Object.assign(pipeline, { canSell: stockOf(2) });
      expect(await send({ ...twoLines, operationReference: id(32) })).toMatchObject({
        status: "Placed",
      });
    });

    it("WP-2423: names a drink short only because another drink uses the same milk (checkout's answer)", async () => {
      const { pipeline, send, onUnexpected } = setup();
      let lines: { cartItemReference: string; quantity: number }[] = [];
      pipeline.addItem.mockImplementation((async (_c: unknown, input: { quantity: number }) => {
        lines = [...lines, { cartItemReference: id(40 + lines.length), quantity: input.quantity }];
        return { status: "Applied" as const, cartVersion: 2 + lines.length, lines };
      }) as never);
      pipeline.startCheckout.mockResolvedValueOnce({
        status: "ItemShort",
        cartItemReference: id(41),
        available: 1,
        sharedStock: true,
      } as never);
      await expect(
        send({
          lines: [
            { sellableReference: id(2), quantity: 2, optionSelections: [] },
            { sellableReference: id(3), quantity: 2, optionSelections: [] },
          ],
        }),
      ).rejects.toMatchObject({
        code: "COUNTER_ORDER_STOCK_SHORT",
        lineIndex: 1,
        available: 1,
        sharedStock: true,
      });
      expect(pipeline.preparePayment).not.toHaveBeenCalled();
      expect(onUnexpected).not.toHaveBeenCalled();
    });

    it("WP-2423: nothing left beside the rest, or stock gone at submission, is 'can't be sold' (not an outage)", async () => {
      const { pipeline, send, onUnexpected } = setup();
      pipeline.addItem.mockResolvedValue({
        status: "Applied",
        cartVersion: 3,
        lines: [{ cartItemReference: id(40), quantity: 1 }],
      } as never);
      pipeline.startCheckout.mockResolvedValueOnce({
        status: "ItemShort",
        cartItemReference: id(40),
        available: 0,
        sharedStock: false,
      } as never);
      await expect(send()).rejects.toMatchObject({
        code: "COUNTER_ORDER_ITEM_UNAVAILABLE",
        lineIndex: 0,
      });
      pipeline.preparePayment.mockRejectedValueOnce(
        Object.assign(new Error("order creation is unavailable"), {
          code: "ORDER_CREATE_STOCK_SHORT",
        }),
      );
      await expect(send({ operationReference: id(33) })).rejects.toMatchObject({
        code: "COUNTER_ORDER_ITEM_UNAVAILABLE",
        lineIndex: null,
      });
      expect(onUnexpected).not.toHaveBeenCalled();
    });

    it("never hides the refusal when the stock cannot be read", async () => {
      const { pipeline, send } = setup();
      Object.assign(pipeline, {
        canSell: vi.fn(async () => {
          throw new Error("INVENTORY_UNAVAILABLE");
        }),
      });
      pipeline.addItem.mockResolvedValueOnce({ status: "NotAvailable" } as never);
      await expect(send()).rejects.toMatchObject({
        code: "COUNTER_ORDER_ITEM_UNAVAILABLE",
        lineIndex: 0,
      });
    });
  });

  it("WP-2423: each counter transaction resolves the caller twice; owner callbacks take its guard", async () => {
    const { send } = setup();
    expect(await send()).toMatchObject({ status: "Placed" });
    // Three transactions (earlier send, entry, finished order), each resolved at its start and
    // re-checked before it commits; the owner reads and writes in between cost no resolution.
    expect(state.allowed.calls).toBe(6);
    expect(state.during.length).toBeGreaterThanOrEqual(3);
    expect(state.during.every((answer) => answer)).toBe(true);
    // The guard ends with its run.
    for (const guard of state.guards) expect(await guard()).toBe(false);
  });

  it("WP-2423: a permission withdrawn during a counter transaction refuses it before commit", async () => {
    const { send, pipeline } = setup();
    let call = 0;
    // Allowed at the start of the entry transaction, withdrawn before it commits.
    state.allowed.fn = async () => ++call !== 4;
    await expect(send()).rejects.toMatchObject({ code: "COUNTER_ORDER_PERMISSION_DENIED" });
    expect(state.allowed.calls).toBe(4);
    // Thrown inside the transaction callback, so the counter entry does not commit.
    expect(state.rolledBack).toBe(1);
    expect(pipeline.addItem).not.toHaveBeenCalled();
  });
});
