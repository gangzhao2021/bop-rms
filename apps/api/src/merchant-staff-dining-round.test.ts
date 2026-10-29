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
    // 46940b76 L6: the command reads both of its permissions at once.
    authorizeActions: async (actions: readonly string[]) =>
      new Map(
        actions.map((action) => [
          action,
          {
            effect:
              action === "dining.operate"
                ? state.tablePermission
                : state.allowed
                  ? "Allow"
                  : "Deny",
          },
        ]),
      ),
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

function setup(
  clock = { at: "2026-10-15T18:00:00.000Z" },
  payLater: {
    sessions: Set<string>;
    confirmed: string[];
    confirm?: () => Promise<void>;
  } | null = null,
) {
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
        started: false,
        generation: 2,
      };
    }),
    abandonTable: vi.fn(async (): Promise<"Closed" | "Kept"> => {
      calls.push("abandonTable");
      return "Closed";
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
    submitPayLater: vi.fn(async () => {
      calls.push("submitPayLater");
      state.batches.set(id(5), {
        orderReference: id(20),
        orderBatchReference: id(21),
        submissionReference: id(22),
        orderNumber: "7",
        orderVersion: 4,
      });
      return {
        submissionReference: id(22),
        kind: "Additional" as const,
        guestSessionReference: id(5),
      };
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
    ...(payLater === null
      ? {}
      : {
          payLater: () =>
            ({
              isPayLater: async (_tx: unknown, session: string) => payLater.sessions.has(session),
              confirm: async (_tx: unknown, input: { submissionReference: string }) => {
                await payLater.confirm?.();
                const status = payLater.confirmed.includes(input.submissionReference)
                  ? "AlreadyConfirmed"
                  : "Confirmed";
                payLater.confirmed.push(input.submissionReference);
                calls.push("confirm");
                return { status, confirmation: { acceptedOrderVersion: 8 } };
              },
              roundTotalMinor: async () => 2260n,
            }) as never,
        }),
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
      payLater: false,
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

  it("DEC-DINE-IN-PAY-LATER: a pay-later table's round goes to the kitchen with nothing to charge", async () => {
    const payLater = { sessions: new Set([id(31)]), confirmed: [] as string[] };
    const { calls, send, pipeline } = setup(undefined, payLater);
    const placed = await send();
    expect(calls.slice(-2)).toEqual(["submitPayLater", "confirm"]);
    expect(pipeline.preparePayment).not.toHaveBeenCalled();
    expect(placed).toEqual({
      status: "Placed",
      orderReference: id(20),
      orderBatchReference: id(21),
      orderNumber: "7",
      orderVersion: 8,
      tableLabel: "T4",
      orderMinor: "2260",
      tipMinor: "0",
      totalMinor: "2260",
      payBy: null,
      payLater: true,
      recordedAfterOutage: false,
    });
    // A retry returns the same round; it is never sent to the kitchen twice.
    const again = await send();
    expect(again).toMatchObject({ status: "AlreadyPlaced", payLater: true, payBy: null });
    expect(pipeline.submitPayLater).toHaveBeenCalledTimes(1);
  });

  it("DEC-DINE-IN-PAY-LATER: a round submitted but not yet sent to the kitchen is sent by the retry", async () => {
    let cut = true;
    const payLater = {
      sessions: new Set([id(31)]),
      confirmed: [] as string[],
      confirm: async () => {
        if (cut) {
          cut = false;
          throw new Error("connection lost");
        }
      },
    };
    const { send, pipeline } = setup(undefined, payLater);
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_IN_PROGRESS" });
    const again = await send();
    expect(again).toMatchObject({ status: "AlreadyPlaced", payLater: true, totalMinor: "2260" });
    expect(payLater.confirmed).toEqual([id(22)]);
    expect(pipeline.submitPayLater).toHaveBeenCalledTimes(1);
  });

  it("DEC-DINE-IN-PAY-LATER: a pay-first table still answers what to charge", async () => {
    const { send, pipeline } = setup(undefined, { sessions: new Set(), confirmed: [] });
    const placed = await send();
    expect(placed).toMatchObject({ payLater: false, payBy: "2026-10-15T18:30:00.000Z" });
    expect(pipeline.submitPayLater).not.toHaveBeenCalled();
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

  it("WP-2423 item 8 ⑦: adds the guests' unsent items to the round only as staff saw them", async () => {
    const withCart = (cartVersion: number) => ({
      status: "Selected" as const,
      cartReference: id(6),
      cartVersion,
      pendingItems: [{ name: "Hong Kong milk tea", quantity: 1 }],
    });
    // After last orders guests can't send: the refusal says so, with the cart version shown.
    const refused = setup();
    Object.assign(refused.pipeline, { guestsCanSend: vi.fn(async () => false) });
    refused.pipeline.selectCart.mockResolvedValueOnce(withCart(3));
    await expect(refused.send()).rejects.toMatchObject({
      code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
      tableCart: { cartVersion: 3, guestsCanSend: false },
    });
    // The cart changed since (a guest added or removed something): refused again, newly named.
    const changed = setup();
    changed.pipeline.selectCart.mockResolvedValueOnce(withCart(4));
    await expect(
      changed.send({ operationReference: id(41), includeTableCart: { expectedCartVersion: 3 } }),
    ).rejects.toMatchObject({
      code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
      tableCart: { cartVersion: 4, guestsCanSend: true },
    });
    expect(changed.pipeline.addItem).not.toHaveBeenCalled();
    // As shown: the round's own lines join the guests' items and the whole cart is sent once,
    // recorded as this staff member's round.
    const added = setup();
    added.pipeline.selectCart.mockResolvedValueOnce(withCart(3));
    const placed = await added.send({
      operationReference: id(42),
      includeTableCart: { expectedCartVersion: 3 },
    });
    expect(placed).toMatchObject({ status: "Placed", orderReference: id(20) });
    expect(added.calls.slice(-4)).toEqual([
      "quote",
      "saveDetails",
      "startCheckout",
      "preparePayment",
    ]);
    expect([...state.entries.values()].at(-1)).toMatchObject({
      actorReference: "0198a7c0-0000-7000-8000-000000000004",
    });
    // The same operation with or without the guests' items is not the same round.
    await expect(added.send({ operationReference: id(42) })).rejects.toMatchObject({
      code: "STAFF_ROUND_IDEMPOTENCY_CONFLICT",
    });
    await expect(
      added.send({ operationReference: id(42), includeTableCart: { expectedCartVersion: 0 } }),
    ).rejects.toMatchObject({ code: "STAFF_ROUND_INPUT_INVALID" });
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

  it("WP-2423 item 7: closes a session it started when the round fails before anything was ordered", async () => {
    const started = {
      status: "Opened" as const,
      diningSessionReference: id(31),
      joinCredential: "123456",
      started: true,
      generation: 1,
    };
    // The table guest can't be bound after the table was opened: the empty session is closed.
    const unbound = setup();
    unbound.pipeline.openTable.mockResolvedValueOnce(started);
    unbound.pipeline.bind.mockRejectedValueOnce(new Error("binding unavailable"));
    await expect(unbound.send()).rejects.toMatchObject({ code: "STAFF_ROUND_UNAVAILABLE" });
    expect(unbound.pipeline.abandonTable).toHaveBeenCalledTimes(1);
    expect(unbound.pipeline.abandonTable).toHaveBeenCalledWith(
      { sessionCookie: "cookie", csrf: "csrf" },
      { tableReference: table, diningSessionReference: id(31), generation: 1 },
    );
    expect(unbound.pipeline.selectCart).not.toHaveBeenCalled();
    // A sold-out line on a table this round opened: nothing ordered, the session is closed too.
    state.entries.clear();
    const soldOut = setup();
    soldOut.pipeline.openTable.mockResolvedValueOnce(started);
    soldOut.pipeline.addItem.mockResolvedValueOnce({ status: "NotAvailable" });
    await expect(soldOut.send()).rejects.toMatchObject({ code: "STAFF_ROUND_ITEM_UNAVAILABLE" });
    expect(soldOut.calls.at(-1)).toBe("abandonTable");
    // Closing it failing never changes the answer staff get; it is reported.
    state.entries.clear();
    const stuck = setup();
    stuck.pipeline.openTable.mockResolvedValueOnce(started);
    stuck.pipeline.join.mockRejectedValueOnce(new Error("join unavailable"));
    const closeFailure = new Error("closing unavailable");
    stuck.pipeline.abandonTable.mockRejectedValueOnce(closeFailure);
    await expect(stuck.send()).rejects.toMatchObject({ code: "STAFF_ROUND_UNAVAILABLE" });
    expect(stuck.onUnexpected).toHaveBeenCalledWith(closeFailure);
  });

  it("WP-2423 item 7: keeps a session that had guests, or once the round's checkout started", async () => {
    // The table already had a session (fresh code only): it is never closed for staff's failure.
    const seated = setup();
    seated.pipeline.bind.mockRejectedValueOnce(new Error("binding unavailable"));
    await expect(seated.send()).rejects.toMatchObject({ code: "STAFF_ROUND_UNAVAILABLE" });
    expect(seated.pipeline.abandonTable).not.toHaveBeenCalled();
    // Checkout started: the round may exist, so the table's session stays for it.
    state.entries.clear();
    const submitted = setup();
    submitted.pipeline.openTable.mockResolvedValueOnce({
      status: "Opened",
      diningSessionReference: id(31),
      joinCredential: "123456",
      started: true,
      generation: 1,
    });
    submitted.pipeline.preparePayment.mockRejectedValueOnce(new Error("connection reset"));
    // WP-2423: the round may exist, so it is "still being sent" (the same command recovers it),
    // never the definite "could not send" that makes the next send a new attempt.
    await expect(submitted.send()).rejects.toMatchObject({ code: "STAFF_ROUND_IN_PROGRESS" });
    expect(submitted.pipeline.abandonTable).not.toHaveBeenCalled();
    // A round placed at a table this request opened keeps its session.
    state.entries.clear();
    state.batches.clear();
    const placed = setup();
    placed.pipeline.openTable.mockResolvedValueOnce({
      status: "Opened",
      diningSessionReference: id(31),
      joinCredential: "123456",
      started: true,
      generation: 1,
    });
    await expect(placed.send()).resolves.toMatchObject({ status: "Placed" });
    expect(placed.pipeline.abandonTable).not.toHaveBeenCalled();
  });

  it("WP-2423: names a short item, takes the round back out of the table's cart and frees a table it opened", async () => {
    const f = setup();
    f.pipeline.openTable.mockResolvedValueOnce({
      status: "Opened",
      diningSessionReference: id(31),
      joinCredential: "123456",
      started: true,
      generation: 1,
    });
    let lines: { cartItemReference: string; quantity: number }[] = [];
    f.pipeline.addItem.mockImplementation((async (_c: unknown, input: { quantity: number }) => {
      lines = [...lines, { cartItemReference: id(40 + lines.length), quantity: input.quantity }];
      return { status: "Applied", cartVersion: 3 + lines.length, lines };
    }) as never);
    f.pipeline.startCheckout.mockResolvedValueOnce({
      status: "ItemShort",
      cartItemReference: id(41),
      available: 1,
      sharedStock: true,
    } as never);
    const removeItems = vi.fn(async () => "Removed" as const);
    Object.assign(f.pipeline, { removeItems });
    await expect(
      f.send({
        lines: [
          { sellableReference: id(2), quantity: 2, optionSelections: [], note: null },
          { sellableReference: id(3), quantity: 2, optionSelections: [], note: null },
        ],
      }),
    ).rejects.toMatchObject({
      code: "STAFF_ROUND_STOCK_SHORT",
      lineIndex: 1,
      available: 1,
      sharedStock: true,
    });
    expect(removeItems).toHaveBeenCalledWith(guest, {
      cartReference: id(6),
      cartVersion: 5,
      cartItemReferences: [id(40), id(41)],
    });
    expect(f.pipeline.preparePayment).not.toHaveBeenCalled();
    expect(f.pipeline.abandonTable).toHaveBeenCalledTimes(1);
    expect(f.onUnexpected).not.toHaveBeenCalled();
  });

  it("WP-2423: keeps the table's cart and session when the round's items could not be taken back", async () => {
    const f = setup();
    f.pipeline.openTable.mockResolvedValueOnce({
      status: "Opened",
      diningSessionReference: id(31),
      joinCredential: "123456",
      started: true,
      generation: 1,
    });
    f.pipeline.addItem.mockResolvedValue({
      status: "Applied",
      cartVersion: 4,
      lines: [{ cartItemReference: id(40), quantity: 2 }],
    } as never);
    f.pipeline.startCheckout.mockResolvedValueOnce({
      status: "ItemShort",
      cartItemReference: id(40),
      available: 0,
      sharedStock: false,
    } as never);
    Object.assign(f.pipeline, { removeItems: vi.fn(async () => "Kept" as const) });
    await expect(f.send()).rejects.toMatchObject({
      code: "STAFF_ROUND_ITEM_UNAVAILABLE",
      lineIndex: 0,
    });
    expect(f.pipeline.abandonTable).not.toHaveBeenCalled();
  });

  it("WP-2423: stock gone at submission is 'can't be sold', the round's items taken back", async () => {
    const f = setup();
    f.pipeline.addItem.mockResolvedValue({
      status: "Applied",
      cartVersion: 4,
      lines: [{ cartItemReference: id(40), quantity: 2 }],
    } as never);
    f.pipeline.preparePayment.mockRejectedValueOnce(
      Object.assign(new Error("order creation is unavailable"), {
        code: "ORDER_CREATE_STOCK_SHORT",
      }),
    );
    const removeItems = vi.fn(async () => "Removed" as const);
    Object.assign(f.pipeline, { removeItems });
    await expect(f.send()).rejects.toMatchObject({
      code: "STAFF_ROUND_ITEM_UNAVAILABLE",
      lineIndex: null,
    });
    expect(removeItems).toHaveBeenCalledTimes(1);
    expect(f.onUnexpected).not.toHaveBeenCalled();
  });

  it("WP-2423: a failure before the checkout takes the round's items back so a new attempt is sent", async () => {
    const f = setup();
    f.pipeline.addItem.mockResolvedValue({
      status: "Applied",
      cartVersion: 4,
      lines: [{ cartItemReference: id(40), quantity: 2 }],
    } as never);
    f.pipeline.quote.mockRejectedValueOnce(new Error("connection reset"));
    const removeItems = vi.fn(async () => "Removed" as const);
    Object.assign(f.pipeline, { removeItems });
    await expect(f.send()).rejects.toMatchObject({ code: "STAFF_ROUND_UNAVAILABLE" });
    expect(removeItems).toHaveBeenCalledWith(guest, {
      cartReference: id(6),
      cartVersion: 4,
      cartItemReferences: [id(40)],
    });
    expect(f.pipeline.startCheckout).not.toHaveBeenCalled();
    // Staff send it again as a new attempt (a new operation): the round is placed once.
    await expect(f.send({ operationReference: id(90) })).resolves.toMatchObject({
      status: "Placed",
    });
    expect(f.pipeline.startCheckout).toHaveBeenCalledTimes(1);
  });

  it("WP-2423: a sold-out later line takes the round's earlier lines back out of the table's cart", async () => {
    const f = setup();
    f.pipeline.addItem
      .mockResolvedValueOnce({
        status: "Applied",
        cartVersion: 4,
        lines: [{ cartItemReference: id(40), quantity: 2 }],
      } as never)
      .mockResolvedValueOnce({ status: "NotAvailable" });
    const removeItems = vi.fn(async () => "Removed" as const);
    Object.assign(f.pipeline, { removeItems });
    await expect(
      f.send({
        lines: [
          { sellableReference: id(2), quantity: 2, optionSelections: [], note: null },
          { sellableReference: id(3), quantity: 1, optionSelections: [], note: null },
        ],
      }),
    ).rejects.toMatchObject({ code: "STAFF_ROUND_ITEM_UNAVAILABLE", lineIndex: 1 });
    expect(removeItems).toHaveBeenCalledWith(guest, {
      cartReference: id(6),
      cartVersion: 4,
      cartItemReferences: [id(40)],
    });
  });
});
