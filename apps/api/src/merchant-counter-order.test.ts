import { beforeEach, describe, expect, it, vi } from "vitest";

// Only the merchant session lookup and the two owner-record readers are doubles; the command's
// own sequencing, idempotency and error mapping are the real code.
const state = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
  orders: new Map<string, Record<string, unknown>>(),
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async () => ({
    selected: { tenantReference: "0198a7c0-0000-7000-8000-000000000001" },
    context: { brand: { brandReference: "0198a7c0-0000-7000-8000-000000000002" } },
    store: { storeReference: "0198a7c0-0000-7000-8000-000000000003" },
    actorReference: "0198a7c0-0000-7000-8000-000000000004",
    allowed: async () => true,
  }),
}));
vi.mock("./counter-payment-preparation.js", () => ({
  readCounterPaymentPreparation: async () => ({
    preparation: {
      orderAllocation: { amountMinor: 1130n },
      tip: { amountMinor: 150n },
      total: { amountMinor: 1280n },
      capacityExpiresAt: "2026-10-13T18:30:00.000Z",
    },
    orderNumber: "12",
    orderVersion: 1,
    paymentOperationReference: "0198a7c0-0000-7000-8000-000000000099",
  }),
}));
vi.mock("@rms/ordering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/ordering")>();
  return {
    ...actual,
    createPostgresCounterOrderEntryStore: () => ({
      loadByOperation: async (_tx: unknown, operation: string) =>
        state.entries.get(operation) ?? null,
      record: async (_tx: unknown, value: Record<string, unknown>) => {
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
      transactions: { run: async (work: (tx: unknown) => Promise<unknown>) => work({}) },
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
});
