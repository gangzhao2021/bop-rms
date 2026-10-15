import { beforeEach, describe, expect, it, vi } from "vitest";

// WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND). Only the merchant session lookup, the Ordering
// staff record store, the Dining table label read and the payment preparation reader are doubles;
// the command's sequencing, permission checks, idempotency and error mapping are the real code.
const state = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
  batches: new Map<string, Record<string, unknown>>(),
  tablePermission: "Allow" as "Allow" | "Deny",
  allowed: true,
}));
vi.mock("./merchant-store-scope.js", () => ({
  createMerchantStoreScope: () => async () => ({
    selected: { tenantReference: "0198a7c0-0000-7000-8000-000000000001" },
    context: { brand: { brandReference: "0198a7c0-0000-7000-8000-000000000002" } },
    store: { storeReference: "0198a7c0-0000-7000-8000-000000000003" },
    actorReference: "0198a7c0-0000-7000-8000-000000000004",
    allowed: async () => state.allowed,
    authorizeAction: async () => ({ effect: state.tablePermission }),
  }),
}));
vi.mock("./staff-dining-round-payment-preparation.js", () => ({
  readStaffDiningRoundPaymentPreparation: async () => ({
    preparation: {
      orderAllocation: { amountMinor: 2260n },
      tip: { amountMinor: 300n },
      total: { amountMinor: 2560n },
      capacityExpiresAt: "2026-10-15T18:30:00.000Z",
    },
    paymentOperationReference: "0198a7c0-0000-7000-8000-000000000099",
    additional: true,
  }),
}));
vi.mock("@rms/dining", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/dining")>();
  return {
    ...actual,
    listDiningSessionTableLabels: async (_tx: unknown, _scope: unknown, sessions: string[]) =>
      new Map(sessions.map((session) => [session, "T4"])),
  };
});
vi.mock("@rms/ordering", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/ordering")>();
  return {
    ...actual,
    createPostgresStaffDiningRoundEntryStore: () => ({
      loadByOperation: async (_tx: unknown, operation: string) =>
        state.entries.get(operation) ?? null,
      record: async (_tx: unknown, value: Record<string, unknown>) => {
        const key = String(value.operationReference);
        const prior = state.entries.get(key);
        if (prior) return { status: "AlreadyRecorded", record: prior };
        state.entries.set(key, value);
        return { status: "Created", record: value };
      },
      loadBatch: async (_tx: unknown, guest: string) => state.batches.get(guest) ?? null,
    }),
    // WP-2423 D1: a later round's table Order is at the version its rounds moved it to (7), not
    // the Order header's version (4).
    createPostgresAdditionalDiningExecutionReader: () => ({
      loadBySubmission: async () => ({ orderVersion: 7 }),
    }),
  };
});

const { createMerchantStaffDiningRound, parseStaffDiningRoundCommand, StaffDiningRoundError } =
  await import("./merchant-staff-dining-round.js");

const id = (n: number) => `0198a7c0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const guest = { sessionCredential: "a".repeat(43), csrfCredential: "b".repeat(43) };
const table = id(30);

function setup(clock = { at: "2026-10-15T18:00:00.000Z" }) {
  let sequence = 0x100;
  const calls: string[] = [];
  const pipeline = {
    takesOrder: vi.fn(async (input: { recordedAfterOutage: boolean }) => {
      calls.push("takesOrder");
      return typeof input.recordedAfterOutage === "boolean";
    }),
    openTable: vi.fn(async () => {
      calls.push("openTable");
      return {
        status: "Opened" as const,
        diningSessionReference: id(31),
        joinCredential: "123456",
      };
    }),
    enter: vi.fn(async () => {
      calls.push("enter");
      return { status: "Established" as const, credentials: guest };
    }),
    join: vi.fn(async () => {
      calls.push("join");
      return { admissionReference: id(32) };
    }),
    bind: vi.fn(async () => {
      calls.push("bind");
      return { credentials: guest, guestSessionReference: id(5) };
    }),
    selectCart: vi.fn(
      async (): Promise<
        | {
            status: "Selected";
            cartReference: string;
            cartVersion: number;
            pendingItems: { name: string; quantity: number }[];
          }
        | { status: "CheckoutInProgress" }
      > => {
        calls.push("selectCart");
        return { status: "Selected", cartReference: id(6), cartVersion: 3, pendingItems: [] };
      },
    ),
    addItem: vi.fn(
      async (): Promise<
        | { status: "Applied"; cartVersion: number }
        | { status: "NotAvailable" }
        | { status: "CheckoutInProgress" }
      > => {
        calls.push("addItem");
        return { status: "Applied", cartVersion: 4 };
      },
    ),
    quote: vi.fn(async () => {
      calls.push("quote");
      return {
        status: "Quoted" as const,
        quoteReference: id(7),
        subtotalMinor: 2000n,
        totalMinor: 2260n,
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
      state.batches.set(id(5), {
        orderReference: id(20),
        orderBatchReference: id(21),
        submissionReference: id(22),
        orderNumber: "7",
        orderVersion: 4,
      });
      return { tip: { amountMinor: input.tip.amountMinor } } as never;
    }),
  };
  const onUnexpected = vi.fn();
  const command = createMerchantStaffDiningRound({
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
        tableReference: table,
        lines: [
          { sellableReference: id(2), quantity: 2, optionSelections: [], note: " no onions " },
        ],
        tip: { kind: "Percent", percent: 15 },
        recordedAfterOutage: false,
        ...overrides,
      },
    });
  return { pipeline, calls, onUnexpected, send, clock };
}

describe("staff dine-in round command — WP-2423 Q7 slice 2", () => {
  beforeEach(() => {
    state.entries.clear();
    state.batches.clear();
    state.tablePermission = "Allow";
    state.allowed = true;
  });

  it("runs the table guest path in the customer's order and answers what to charge", async () => {
    const { calls, send, pipeline } = setup();
    const placed = await send();
    expect(calls).toEqual([
      "takesOrder",
      "enter",
      "openTable",
      "join",
      "bind",
      "selectCart",
      "addItem",
      "quote",
      "saveDetails",
      "startCheckout",
      "preparePayment",
    ]);
    expect(pipeline.openTable).toHaveBeenCalledWith(
      { sessionCookie: "cookie", csrf: "csrf" },
      { tableReference: table },
    );
    expect((pipeline.join.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
      joinCredential: "123456",
    });
    // The guest's note goes to the kitchen with the item (trimmed by the Ordering rule).
    expect((pipeline.addItem.mock.calls[0] as unknown[] | undefined)?.[1]).toMatchObject({
      quantity: 2,
      customerNote: "no onions",
      cartReference: id(6),
      expectedCartVersion: 3,
    });
    // 15 % of the quote subtotal, rounded half up.
    expect(pipeline.preparePayment.mock.calls[0]?.[1]).toMatchObject({
      tip: { amountMinor: 300n, currencyCode: "CAD" },
    });
    expect(placed).toEqual({
      status: "Placed",
      orderReference: id(20),
      orderBatchReference: id(21),
      orderNumber: "7",
      orderVersion: 7,
      tableLabel: "T4",
      orderMinor: "2260",
      tipMinor: "300",
      totalMinor: "2560",
      payBy: "2026-10-15T18:30:00.000Z",
      recordedAfterOutage: false,
    });
    // The staff member, table, session and table guest are recorded once.
    expect([...state.entries.values()][0]).toMatchObject({
      actorReference: "0198a7c0-0000-7000-8000-000000000004",
      tableReference: table,
      diningSessionReference: id(31),
      guestSessionReference: id(5),
      recordedAfterOutage: false,
    });
  });

  it("returns the same round for a retry, never a second one", async () => {
    const { send, pipeline } = setup();
    await send();
    const again = await send();
    expect(again.status).toBe("AlreadyPlaced");
    expect(again.orderBatchReference).toBe(id(21));
    expect(pipeline.openTable).toHaveBeenCalledTimes(1);
    // A different order under the same operation is a conflict.
    await expect(send({ tip: { kind: "None" } })).rejects.toMatchObject({
      code: "STAFF_ROUND_IDEMPOTENCY_CONFLICT",
    });
  });

  it("refuses without the staff ordering or table permission", async () => {
    const { send, pipeline } = setup();
    state.allowed = false;
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_PERMISSION_DENIED" });
    state.allowed = true;
    state.tablePermission = "Deny";
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_PERMISSION_DENIED" });
    expect(pipeline.openTable).not.toHaveBeenCalled();
  });

  it("refuses items guests left in the table's shared cart, naming them", async () => {
    const { send, pipeline } = setup();
    pipeline.selectCart.mockResolvedValueOnce({
      status: "Selected",
      cartReference: id(6),
      cartVersion: 3,
      pendingItems: [{ name: "Iced latte", quantity: 1 }],
    });
    const error = await send().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StaffDiningRoundError);
    expect(error).toMatchObject({
      code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
      pendingItems: [{ name: "Iced latte", quantity: 1 }],
    });
    expect(pipeline.addItem).not.toHaveBeenCalled();
  });

  it("names the sold-out line and a guest paying at the table, and a table that can't be seated", async () => {
    const soldOut = setup();
    soldOut.pipeline.addItem.mockResolvedValueOnce({ status: "NotAvailable" });
    await expect(soldOut.send()).rejects.toMatchObject({
      code: "STAFF_ROUND_ITEM_UNAVAILABLE",
      lineIndex: 0,
    });
    state.entries.clear();
    const paying = setup();
    paying.pipeline.addItem.mockResolvedValueOnce({ status: "CheckoutInProgress" });
    await expect(paying.send()).rejects.toMatchObject({
      code: "STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS",
    });
    state.entries.clear();
    const blocked = setup();
    blocked.pipeline.openTable.mockResolvedValueOnce({ status: "TableUnavailable" } as never);
    await expect(blocked.send()).rejects.toMatchObject({ code: "STAFF_ROUND_TABLE_UNAVAILABLE" });
    expect(blocked.pipeline.join).not.toHaveBeenCalled();
  });

  it("DEC-STAFF-DINE-IN-ROUND: a table without a QR code is refused before the table is opened", async () => {
    const { send, pipeline } = setup();
    pipeline.enter.mockResolvedValueOnce({ status: "NoTableQr" } as never);
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_TABLE_QR_MISSING" });
    // No dining session is started or code issued for a round that can't be entered.
    expect(pipeline.openTable).not.toHaveBeenCalled();
    expect(pipeline.join).not.toHaveBeenCalled();
  });

  it("takes a paper round after closing and refuses a new one while the store is closed", async () => {
    const closed = setup();
    closed.pipeline.takesOrder.mockImplementation(async (input) => input.recordedAfterOutage);
    await expect(closed.send()).rejects.toMatchObject({
      code: "STAFF_ROUND_STORE_NOT_TAKING_ORDERS",
    });
    const paper = await closed.send({ operationReference: id(2), recordedAfterOutage: true });
    expect(paper.recordedAfterOutage).toBe(true);
  });

  it("answers in progress, then not finished, for an attempt that made no round", async () => {
    const { send, pipeline, clock, onUnexpected } = setup();
    pipeline.quote.mockRejectedValueOnce(new Error("connection reset"));
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_UNAVAILABLE" });
    expect(onUnexpected).toHaveBeenCalledTimes(1);
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_IN_PROGRESS" });
    clock.at = "2026-10-15T18:05:00.000Z";
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_NOT_FINISHED" });
  });

  it("validates the command: table, lines, notes and tip", () => {
    const base = {
      operationReference: id(1),
      tableReference: table,
      lines: [{ sellableReference: id(2), quantity: 1, optionSelections: [], note: null }],
      tip: { kind: "None" },
      recordedAfterOutage: false,
    };
    expect(parseStaffDiningRoundCommand(base).lines[0]?.note).toBeNull();
    for (const bad of [
      { ...base, tableReference: "T4" },
      { ...base, lines: [] },
      { ...base, lines: [{ ...base.lines[0], note: "x".repeat(501) }] },
      { ...base, lines: [{ ...base.lines[0], note: "\u0007" }] },
      { ...base, lines: [{ sellableReference: id(2), quantity: 1, optionSelections: [] }] },
      { ...base, tip: { kind: "Percent", percent: 12 } },
      { ...base, extra: true },
    ])
      expect(() => parseStaffDiningRoundCommand(bad)).toThrow(StaffDiningRoundError);
  });
});
