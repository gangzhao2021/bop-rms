import { beforeEach, describe, expect, it, vi } from "vitest";

// WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND). Only the merchant session lookup, the Ordering
// staff record store, the Dining table label read and the payment preparation reader are doubles;
// the command's sequencing, permission checks, idempotency and error mapping are the real code.
const state = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
  batches: new Map<string, Record<string, unknown>>(),
  tablePermission: "Allow" as "Allow" | "Deny",
  allowed: true,
  // WP-2423 item 8 ⑦ (Owner decision 11): the Store's tip choices.
  tips: { enabled: true, tierPercents: [10, 15, 18] as readonly number[] },
  // WP-2423 M35: the table's cart as the read-only check before the table is opened sees it
  // (null: the table has no open session), and the staff removals asked for.
  tableCart: null as null | {
    cartReference: string;
    cartVersion: number;
    lines: { cartItemReference: string; sellableReference: string; quantity: number }[];
  },
  staffRemovals: [] as Record<string, unknown>[],
  staffRemovalError: null as null | Error,
  /** The table's current party when set (otherwise as the cart above implies). */
  tableSession: undefined as string | null | undefined,
  // DEC-PAPER-SEND-IDEMPOTENT: whether the round still waits for its payment, and its card
  // machine (or paper) payment record once paid.
  waitsForPayment: true,
  paid: null as Record<string, unknown> | null,
  /** b11: the System (or staff) took the round off. */
  takenOff: false,
  /** What the table's cart does with a staff removal (the shared-cart double below). */
  onStaffRemoval: null as
    | null
    | ((input: {
        expectedCartVersion: number;
        keep: readonly string[];
        lines: readonly { cartItemReference: string; reason: string }[];
      }) => Promise<{ status: "Removed"; cartVersion: number }>),
}));
vi.mock("@rms/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/catalog")>()),
  listStoreMenuSellableNames: async () => new Map(),
}));
vi.mock("./merchant-store-features.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./merchant-store-features.js")>()),
  readStoreTipChoices: async () => state.tips,
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
vi.mock("@rms/payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/payment")>()),
  createPostgresCardMachinePaymentStore: () => ({ loadByBatch: async () => state.paid }),
}));
vi.mock("./staff-dining-round-payment-preparation.js", () => ({
  readStaffDiningRoundPaymentPreparation: async () =>
    state.waitsForPayment
      ? {
          preparation: {
            orderAllocation: { amountMinor: 2260n },
            tip: { amountMinor: 300n },
            total: { amountMinor: 2560n },
            capacityExpiresAt: "2026-10-15T18:30:00.000Z",
          },
          paymentOperationReference: "0198a7c0-0000-7000-8000-000000000099",
          additional: true,
        }
      : null,
}));
vi.mock("@rms/dining", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rms/dining")>();
  return {
    ...actual,
    listDiningSessionTableLabels: async (_tx: unknown, _scope: unknown, sessions: string[]) =>
      new Map(sessions.map((session) => [session, "T4"])),
    createPostgresDiningTableStore: () => ({
      loadTable: async () => ({
        activeDiningSessionReference:
          state.tableSession !== undefined
            ? state.tableSession
            : state.tableCart === null
              ? null
              : "0198a7c0-0000-7000-8000-00000000001f",
      }),
    }),
    createPostgresDiningCheckoutHoldSource: () => ({ read: async () => null }),
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
      isTakenOff: async () => state.takenOff,
    }),
    // WP-2423 D1: a later round's table Order is at the version its rounds moved it to (7), not
    // the Order header's version (4).
    createPostgresAdditionalDiningExecutionReader: () => ({
      loadBySubmission: async () => ({ orderVersion: 7 }),
    }),
    readStaffDiningCart: async () =>
      state.tableCart === null
        ? null
        : {
            ...state.tableCart,
            lines: state.tableCart.lines.map((line) => ({
              ...line,
              optionCount: 0,
              optionSelections: [],
              addedByParticipantReference: null,
              addedAt: "2026-10-15T17:59:00.000Z",
            })),
          },
    removeStaffDiningCartLines: async (
      _tx: unknown,
      _scope: unknown,
      input: { expectedCartVersion: number; lines: unknown[] },
    ) => {
      state.staffRemovals.push(input as never);
      if (state.staffRemovalError !== null) throw state.staffRemovalError;
      if (state.onStaffRemoval !== null) return state.onStaffRemoval(input as never);
      return { status: "Removed", cartVersion: input.expectedCartVersion + input.lines.length };
    },
  };
});

const {
  createMerchantStaffDiningRound,
  parseStaffDiningRoundCommand,
  StaffDiningRoundError,
  staffRemovalReference,
} = await import("./merchant-staff-dining-round.js");
const { CartError } = await import("@rms/ordering");

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
    tableHasQr: vi.fn(async () => true),
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
            pendingItems: {
              cartItemReference: string;
              name: string;
              quantity: number;
              standing: "Available" | "Unavailable" | "OptionsChanged" | "Short";
            }[];
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
      transactions: {
        run: async (work: (tx: unknown) => Promise<unknown>) =>
          work({ query: async () => ({ rows: [] }) }),
      },
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
    state.tips = { enabled: true, tierPercents: [10, 15, 18] };
    state.tableCart = null;
    state.staffRemovals = [];
    state.staffRemovalError = null;
    state.onStaffRemoval = null;
    state.waitsForPayment = true;
    state.paid = null;
    state.takenOff = false;
    state.tableSession = undefined;
  });

  it("v15 staff-round-speed: a round taken for a party that has left is refused before the table is touched", async () => {
    const f = setup();
    // Taken for party id(31); that party left and the table was cleaned: free, or a new party.
    for (const now of [null, id(40)]) {
      state.tableSession = now;
      await expect(
        f.send({ operationReference: id(0x501), expectedDiningSessionReference: id(31) }),
      ).rejects.toMatchObject({ code: "STAFF_ROUND_TABLE_PARTY_CHANGED" });
    }
    expect(f.calls).not.toContain("openTable");
    expect(f.calls).not.toContain("join");
    expect(state.entries.size).toBe(0);
  });

  it("v15 staff-round-speed: the same party, or a table free when staff began, is sent as before", async () => {
    const f = setup();
    state.tableSession = id(31);
    expect(
      await f.send({ operationReference: id(0x502), expectedDiningSessionReference: id(31) }),
    ).toMatchObject({ status: "Placed" });
    expect(f.pipeline.openTable).toHaveBeenLastCalledWith(expect.anything(), {
      tableReference: expect.any(String),
      expectedDiningSessionReference: id(31),
    });
    state.tableSession = id(40);
    expect(
      await f.send({ operationReference: id(0x503), expectedDiningSessionReference: null }),
    ).toMatchObject({ status: "Placed" });
    expect(f.pipeline.openTable).toHaveBeenLastCalledWith(expect.anything(), {
      tableReference: expect.any(String),
    });
  });

  it("v15 staff-round-speed: a party that leaves just as the table is opened is refused there, nothing recorded", async () => {
    const f = setup();
    state.tableSession = id(31);
    f.pipeline.openTable.mockResolvedValueOnce({ status: "PartyChanged" } as never);
    await expect(
      f.send({ operationReference: id(0x504), expectedDiningSessionReference: id(31) }),
    ).rejects.toMatchObject({ code: "STAFF_ROUND_TABLE_PARTY_CHANGED" });
    expect(f.calls).not.toContain("join");
    expect(state.entries.size).toBe(0);
  });

  it("WP-2423 item 8 ⑦: a staff round takes only a tip the Store offers; with tips off, none", async () => {
    const { send, pipeline } = setup();
    state.tips = { enabled: false, tierPercents: [10, 15, 18] };
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_TIPS_OFF" });
    await expect(send({ tip: { kind: "Amount", amountMinor: "300" } })).rejects.toMatchObject({
      code: "STAFF_ROUND_TIPS_OFF",
    });
    // Refused before the table was entered or anything ordered.
    expect(pipeline.takesOrder).not.toHaveBeenCalled();
    state.tips = { enabled: true, tierPercents: [12, 16, 20] };
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_TIP_CHOICES_CHANGED" });
    expect(pipeline.takesOrder).not.toHaveBeenCalled();
  });

  it("runs the table guest path in the customer's order and answers what to charge", async () => {
    const { calls, send, pipeline } = setup();
    const placed = await send();
    expect(calls).toEqual([
      "takesOrder",
      "openTable",
      "enter",
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
    // WP-2423 DEC-MERCHANT-LOCK-SCOPE: the round exists, so it is sent there and then.
    await expect(send()).resolves.toMatchObject({ status: "Placed", payLater: true });
    expect(payLater.confirmed).toEqual([id(22)]);
    const again = await send();
    expect(again).toMatchObject({ status: "AlreadyPlaced", payLater: true, totalMinor: "2260" });
    expect(pipeline.submitPayLater).toHaveBeenCalledTimes(1);
  });

  it("DEC-DINE-IN-PAY-LATER: still cut off when it is read again: the same command sends it", async () => {
    let cuts = 2;
    const payLater = {
      sessions: new Set([id(31)]),
      confirmed: [] as string[],
      confirm: async () => {
        if (cuts > 0) {
          cuts -= 1;
          throw new Error("connection lost");
        }
      },
    };
    const { send, pipeline } = setup(undefined, payLater);
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_IN_PROGRESS" });
    await expect(send()).resolves.toMatchObject({ status: "AlreadyPlaced", payLater: true });
    expect(pipeline.submitPayLater).toHaveBeenCalledTimes(1);
  });

  it("WP-2423: a step that failed with no round behind it takes the items back, and says so", async () => {
    const f = setup();
    f.pipeline.addItem.mockResolvedValue({
      status: "Applied",
      cartVersion: 4,
      lines: [{ cartItemReference: id(40), quantity: 2 }],
    } as never);
    f.pipeline.preparePayment.mockRejectedValueOnce(new Error("lock timeout"));
    const removeItems = vi.fn(async () => "Removed" as const);
    Object.assign(f.pipeline, { removeItems });
    await expect(f.send()).rejects.toMatchObject({ code: "STAFF_ROUND_UNAVAILABLE" });
    expect(removeItems).toHaveBeenCalledTimes(1);
  });

  it("WP-2423: a round that went through just as its step failed stands, and nothing is removed twice", async () => {
    const f = setup();
    f.pipeline.addItem.mockResolvedValue({
      status: "Applied",
      cartVersion: 4,
      lines: [{ cartItemReference: id(40), quantity: 2 }],
    } as never);
    const real = f.pipeline.preparePayment.getMockImplementation();
    f.pipeline.preparePayment.mockImplementationOnce(async (credentials, input) => {
      await real?.(credentials, input);
      throw new Error("reply lost");
    });
    const removeItems = vi.fn(async () => "Removed" as const);
    Object.assign(f.pipeline, { removeItems });
    await expect(f.send()).resolves.toMatchObject({ status: "Placed" });
    expect(removeItems).not.toHaveBeenCalled();
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

  // DEC-PAPER-SEND-IDEMPOTENT (v15 batch-9 L5): a paper round the table pays now is paid with its
  // send; when the answer is lost the same send finds it paid and returns it, at any time.
  it("returns a paid round to the same send with the amounts its payment record holds", async () => {
    const clock = { at: "2026-10-15T18:00:00.000Z" };
    const { send, pipeline } = setup(clock);
    const first = await send({ recordedAfterOutage: true });
    state.waitsForPayment = false;
    await expect(send({ recordedAfterOutage: true })).rejects.toMatchObject({
      code: "STAFF_ROUND_IN_PROGRESS",
    });
    // Its time to pay ended and it was taken off: named by its order and table, never "didn't
    // go through", once it can no longer be still sending.
    clock.at = "2026-10-15T18:05:00.000Z";
    await expect(send({ recordedAfterOutage: true })).rejects.toMatchObject({
      code: "STAFF_ROUND_ALREADY_SENT",
      placedOrderNumber: first.orderNumber,
      placedTableLabel: first.tableLabel,
    });
    clock.at = "2026-10-15T18:00:00.000Z";
    state.paid = {
      preparation: {
        orderAllocation: { amountMinor: 2260n },
        tip: { amountMinor: 300n },
        total: { amountMinor: 2560n },
        capacityExpiresAt: "2026-10-15T18:30:00.000Z",
      },
    };
    clock.at = "2026-10-15T20:00:00.000Z";
    expect(await send({ recordedAfterOutage: true })).toMatchObject({
      status: "AlreadyPlaced",
      orderBatchReference: id(21),
      orderMinor: "2260",
      tipMinor: "300",
      totalMinor: "2560",
      payBy: "2026-10-15T18:30:00.000Z",
      payLater: false,
      recordedAfterOutage: true,
      paid: true,
    });
    expect(pipeline.openTable).toHaveBeenCalledTimes(1);
  });

  // DEC-PAPER-SEND-IDEMPOTENT (b11 major): the System took an unpaid round off while its payment
  // clock stayed open; sent again it is named by its order, never offered for a card charge.
  it("names a round the System took off when it is sent again, never asking to charge it", async () => {
    const clock = { at: "2026-10-15T18:00:00.000Z" };
    const { send, pipeline } = setup(clock);
    const first = await send();
    state.takenOff = true;
    await expect(send()).rejects.toMatchObject({
      code: "STAFF_ROUND_ALREADY_SENT",
      placedOrderNumber: first.orderNumber,
      placedTableLabel: first.tableLabel,
    });
    // Its time to pay ended but the System has not taken it off yet: named the same way.
    state.takenOff = false;
    clock.at = "2026-10-15T18:31:00.000Z";
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_ALREADY_SENT" });
    // Paid before it ended: still the paid round, never "taken off".
    state.paid = {
      preparation: {
        orderAllocation: { amountMinor: 2260n },
        tip: { amountMinor: 300n },
        total: { amountMinor: 2560n },
        capacityExpiresAt: "2026-10-15T18:30:00.000Z",
      },
    };
    expect(await send()).toMatchObject({ status: "AlreadyPlaced", paid: true });
    expect(pipeline.openTable).toHaveBeenCalledTimes(1);
  });

  // DEC-PAPER-SEND-IDEMPOTENT: a round's payment clock stays open once it is paid, so a round sent
  // again while its preparation is still read is marked paid from its payment record.
  it("marks a round sent again paid when its payment is recorded, though its clock is open", async () => {
    const { send } = setup({ at: "2026-10-15T18:00:00.000Z" });
    state.paid = {
      preparation: {
        orderAllocation: { amountMinor: 2260n },
        tip: { amountMinor: 300n },
        total: { amountMinor: 2560n },
        capacityExpiresAt: "2026-10-15T18:30:00.000Z",
      },
    };
    // A first send is never "paid", whatever the record says.
    expect((await send()).paid).toBeUndefined();
    expect(await send()).toMatchObject({ status: "AlreadyPlaced", totalMinor: "2560", paid: true });
    state.paid = null;
    expect((await send()).paid).toBeUndefined();
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
      pendingItems: [
        { cartItemReference: id(60), name: "Iced latte", quantity: 1, standing: "Available" },
      ],
    });
    const error = await send().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(StaffDiningRoundError);
    expect(error).toMatchObject({
      code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
      pendingItems: [
        { cartItemReference: id(60), name: "Iced latte", quantity: 1, standing: "Available" },
      ],
    });
    expect(pipeline.addItem).not.toHaveBeenCalled();
  });

  it("WP-2423 item 8 ⑦: adds the guests' unsent items to the round only as staff saw them", async () => {
    const withCart = (cartVersion: number) => ({
      status: "Selected" as const,
      cartReference: id(6),
      cartVersion,
      pendingItems: [
        {
          cartItemReference: id(60),
          name: "Hong Kong milk tea",
          quantity: 1,
          standing: "Available" as const,
        },
      ],
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
    // WP-2423 item 13 ②: a free table while the platform paused new guests says so.
    state.entries.clear();
    const paused = setup();
    paused.pipeline.openTable.mockResolvedValueOnce({ status: "NewGuestsPaused" } as never);
    await expect(paused.send()).rejects.toMatchObject({ code: "STAFF_ROUND_NEW_GUESTS_PAUSED" });
    expect(paused.pipeline.join).not.toHaveBeenCalled();
  });

  it("DEC-STAFF-DINE-IN-ROUND: a table without a QR code is refused before the table is opened", async () => {
    const { send, pipeline } = setup();
    pipeline.tableHasQr.mockResolvedValueOnce(false);
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_TABLE_QR_MISSING" });
    // No dining session is started or code issued for a round that can't be entered.
    expect(pipeline.openTable).not.toHaveBeenCalled();
    expect(pipeline.join).not.toHaveBeenCalled();
  });

  it("closes the table it started when the entry is then refused: no empty session on the floor", async () => {
    const { send, pipeline, calls } = setup();
    pipeline.openTable.mockResolvedValueOnce({
      status: "Opened",
      diningSessionReference: id(31),
      joinCredential: "join",
      started: true,
      generation: 1,
    } as never);
    pipeline.enter.mockResolvedValueOnce({ status: "NotAccepting" } as never);
    await expect(send()).rejects.toMatchObject({ code: "STAFF_ROUND_STORE_NOT_TAKING_ORDERS" });
    expect(calls).toContain("abandonTable");
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
      // A whole percentage 1–50 (the Store's tiers are checked when the round is sent).
      { ...base, tip: { kind: "Percent", percent: 51 } },
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
    // Read again, the Cart still holds the round's line at the version it went in at.
    f.pipeline.selectCart
      .mockResolvedValueOnce({
        status: "Selected",
        cartReference: id(6),
        cartVersion: 3,
        pendingItems: [],
      })
      .mockResolvedValueOnce({
        status: "Selected",
        cartReference: id(6),
        cartVersion: 4,
        pendingItems: [
          { cartItemReference: id(40), name: "Soup", quantity: 2, standing: "Available" },
        ],
      });
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

  it("WP-2423: an owner listing mid-round asks staff to send again, the round's items taken back", async () => {
    const atCheckout = setup();
    atCheckout.pipeline.addItem.mockResolvedValue({
      status: "Applied",
      cartVersion: 4,
      lines: [{ cartItemReference: id(40), quantity: 2 }],
    } as never);
    atCheckout.pipeline.startCheckout.mockResolvedValueOnce({
      status: "RequoteRequired",
    } as never);
    const removedAtCheckout = vi.fn(async () => "Removed" as const);
    Object.assign(atCheckout.pipeline, { removeItems: removedAtCheckout });
    await expect(atCheckout.send()).rejects.toMatchObject({ code: "STAFF_ROUND_NOT_PRICED" });
    expect(removedAtCheckout).toHaveBeenCalledTimes(1);
    expect(atCheckout.pipeline.preparePayment).not.toHaveBeenCalled();
    expect(atCheckout.onUnexpected).not.toHaveBeenCalled();
  });

  it("WP-2423: an owner listing just before the submission does the same, nothing ordered", async () => {
    const atSubmission = setup();
    atSubmission.pipeline.addItem.mockResolvedValue({
      status: "Applied",
      cartVersion: 4,
      lines: [{ cartItemReference: id(40), quantity: 2 }],
    } as never);
    atSubmission.pipeline.preparePayment.mockRejectedValueOnce(
      Object.assign(new Error("checkout validation failed"), {
        code: "CHECKOUT_REQUOTE_REQUIRED",
      }),
    );
    const removedAtSubmission = vi.fn(async () => "Removed" as const);
    Object.assign(atSubmission.pipeline, { removeItems: removedAtSubmission });
    await expect(atSubmission.send()).rejects.toMatchObject({ code: "STAFF_ROUND_NOT_PRICED" });
    expect(removedAtSubmission).toHaveBeenCalledTimes(1);
    expect(atSubmission.onUnexpected).not.toHaveBeenCalled();
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

/**
 * WP-2423 (staff-round-soldout, v15 8911a4c1 M06): a guest's item in the table's shared Cart sold
 * out or went off the menu. The Cart below behaves as the real one: one version per change, every
 * line (guests' and the round's) in each answer, and the Ordering owner's remove rule (the round's
 * own lines, or another guest's line only while the Catalog says it can't be sold now).
 */
describe("staff round with a guest item that can't be sold — WP-2423", () => {
  beforeEach(() => {
    state.entries.clear();
    state.batches.clear();
    state.tablePermission = "Allow";
    state.allowed = true;
    state.tips = { enabled: true, tierPercents: [10, 15, 18] };
    state.tableCart = null;
    state.staffRemovals = [];
    state.staffRemovalError = null;
    state.onStaffRemoval = null;
  });
  type Standing = "Available" | "Unavailable" | "OptionsChanged" | "Short";
  let operations = 0x900;
  const fresh = () => id(operations++);
  const plum = id(61),
    noodles = id(62);
  function sharedCart(
    f: ReturnType<typeof setup>,
    guests: { cartItemReference: string; name: string; quantity: number; standing: Standing }[],
  ) {
    const cart = { version: 3, lines: guests.map((line) => ({ ...line })) };
    // What the Catalog says at the remove command's own instant (the Cart's marks may not say it).
    const unsellable = new Set(
      guests.filter((line) => line.standing !== "Available").map((line) => line.cartItemReference),
    );
    const staffLines = new Set<string>();
    let next = 0x70;
    const view = () => ({
      status: "Selected" as const,
      cartReference: id(6),
      cartVersion: cart.version,
      pendingItems: cart.lines.map((line) => ({ ...line })),
    });
    f.pipeline.selectCart.mockImplementation(async () => {
      f.calls.push("selectCart");
      return view();
    });
    f.pipeline.addItem.mockImplementation((async (
      _c: unknown,
      input: { expectedCartVersion: number; quantity: number },
    ) => {
      f.calls.push("addItem");
      if (input.expectedCartVersion !== cart.version) throw new Error("CART_VERSION_CONFLICT");
      const reference = id(next++);
      staffLines.add(reference);
      cart.lines.push({
        cartItemReference: reference,
        name: "Sliced potato",
        quantity: input.quantity,
        standing: "Available",
      });
      cart.version += 1;
      return {
        status: "Applied",
        cartVersion: cart.version,
        lines: cart.lines.map(({ cartItemReference, quantity }) => ({
          cartItemReference,
          quantity,
        })),
      };
    }) as never);
    const removeItems = vi.fn(
      async (
        _c: unknown,
        input: { cartVersion: number; cartItemReferences: readonly string[] },
      ): Promise<"Removed" | "Kept"> => {
        f.calls.push("removeItems");
        let version = input.cartVersion;
        for (const reference of input.cartItemReferences) {
          if (version !== cart.version) return "Kept";
          if (!cart.lines.some((line) => line.cartItemReference === reference)) return "Kept";
          if (!staffLines.has(reference) && !unsellable.has(reference)) return "Kept";
          cart.lines = cart.lines.filter((line) => line.cartItemReference !== reference);
          cart.version += 1;
          version = cart.version;
        }
        return "Removed";
      },
    );
    Object.assign(f.pipeline, { removeItems });
    // WP-2423 M06/M35: staff take guests' lines out all at once, or none when the cart moved on.
    const staffRemoval = vi.fn(
      async (input: {
        expectedCartVersion: number;
        keep: readonly string[];
        lines: readonly { cartItemReference: string; reason: string }[];
      }) => {
        f.calls.push("staffRemoval");
        const decided = new Set([...input.keep, ...input.lines.map((l) => l.cartItemReference)]);
        if (
          input.expectedCartVersion !== cart.version ||
          cart.lines.length !== decided.size ||
          cart.lines.some((line) => !decided.has(line.cartItemReference))
        )
          throw Object.assign(new CartError("CART_VERSION_CONFLICT"));
        const out = new Set(input.lines.map((l) => l.cartItemReference));
        cart.lines = cart.lines.filter((line) => !out.has(line.cartItemReference));
        cart.version += input.lines.length;
        return { status: "Removed" as const, cartVersion: cart.version };
      },
    );
    state.onStaffRemoval = staffRemoval;
    return { cart, unsellable, staffLines, removeItems, staffRemoval, view };
  }
  const guestsAtTable = () => [
    { cartItemReference: plum, name: "Plum juice", quantity: 1, standing: "Unavailable" as const },
    { cartItemReference: noodles, name: "Noodles", quantity: 2, standing: "Available" as const },
  ];
  const including = (removeUnavailable?: string[], expectedCartVersion = 3) => ({
    includeTableCart: {
      expectedCartVersion,
      ...(removeUnavailable === undefined ? {} : { removeUnavailable }),
    },
  });

  it("(a) marks the sold-out guest item and sends nothing until staff decide on it", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    for (const command of [{}, including()])
      await expect(f.send({ operationReference: fresh(), ...command })).rejects.toMatchObject({
        code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
        pendingItems: [
          { cartItemReference: plum, name: "Plum juice", quantity: 1, standing: "Unavailable" },
          { cartItemReference: noodles, name: "Noodles", quantity: 2, standing: "Available" },
        ],
        tableCart: { cartVersion: 3, guestsCanSend: true },
      });
    expect(f.pipeline.quote).not.toHaveBeenCalled();
    expect(f.pipeline.addItem).not.toHaveBeenCalled();
    expect(table.removeItems).not.toHaveBeenCalled();
    expect(f.onUnexpected).not.toHaveBeenCalled();
  });

  it("(b) removes it first, then sends the rest with the round at the Cart's new version", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    const placed = await f.send(including([plum]));
    expect(placed).toMatchObject({ status: "Placed" });
    // WP-2423 M06: taken out as the staff member's own removal (the kitchen can't make it),
    // against the version staff saw, keeping the noodles; never through the guest Cart's remove.
    expect(table.removeItems).not.toHaveBeenCalled();
    expect(table.staffRemoval).toHaveBeenCalledTimes(1);
    expect(table.staffRemoval.mock.calls[0]?.[0]).toMatchObject({
      cartReference: id(6),
      expectedCartVersion: 3,
      keep: [noodles],
      lines: [{ cartItemReference: plum, reason: "CantMake" }],
    });
    expect(f.calls.indexOf("staffRemoval")).toBeLessThan(f.calls.indexOf("addItem"));
    expect(f.pipeline.addItem).toHaveBeenCalledWith(
      guest,
      expect.objectContaining({ expectedCartVersion: 4 }),
    );
    // What is sent: the noodles and the round's own line, never the plum juice.
    expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles", "Sliced potato"]);
    expect(f.pipeline.quote).toHaveBeenCalledWith(
      guest,
      expect.objectContaining({ cartVersion: 5 }),
    );
    // The intent names the removed lines: another removal under the same operation conflicts.
    await expect(f.send(including([noodles]))).rejects.toMatchObject({
      code: "STAFF_ROUND_IDEMPOTENCY_CONFLICT",
    });
  });

  it("(c) every line listed leaves at once as the staff member's removal; one not in the Cart removes nothing", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    const placed = await f.send(including([plum, noodles]));
    expect(placed).toMatchObject({ status: "Placed" });
    expect(table.staffRemoval.mock.calls[0]?.[0]).toMatchObject({
      keep: [],
      lines: [
        { cartItemReference: plum, reason: "CantMake" },
        { cartItemReference: noodles, reason: "CantMake" },
      ],
    });
    expect(table.cart.lines.map((line) => line.name)).toEqual(["Sliced potato"]);
    // A line that is not in the Cart (a guest removed it): refused, nothing removed.
    const g = setup();
    const other = sharedCart(g, guestsAtTable());
    await expect(
      g.send({ operationReference: fresh(), ...including([plum, id(99)]) }),
    ).rejects.toMatchObject({ code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS" });
    expect(other.removeItems).not.toHaveBeenCalled();
    expect(other.staffRemoval).not.toHaveBeenCalled();
    expect(other.cart.lines).toHaveLength(2);
    // Duplicates and more than 30 lines are not a command.
    for (const removeUnavailable of [[plum, plum], Array.from({ length: 31 }, (_, n) => id(n))])
      await expect(
        g.send({ operationReference: fresh(), ...including(removeUnavailable) }),
      ).rejects.toMatchObject({ code: "STAFF_ROUND_INPUT_INVALID" });
  });

  it("(d) a guest who changed the Cart during the removal: staff see the Cart as it is now", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    const real = table.staffRemoval.getMockImplementation();
    table.staffRemoval.mockImplementationOnce(async (input) => {
      const removed = await (real as NonNullable<typeof real>)(input);
      // A guest adds another plum juice just after.
      table.cart.lines.push({
        cartItemReference: id(63),
        name: "Plum juice",
        quantity: 1,
        standing: "Unavailable",
      });
      table.cart.version += 1;
      return removed;
    });
    await expect(f.send(including([plum]))).rejects.toMatchObject({
      code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
      pendingItems: [
        { cartItemReference: noodles, standing: "Available" },
        { cartItemReference: id(63), standing: "Unavailable" },
      ],
      tableCart: { cartVersion: 5 },
    });
    expect(f.pipeline.addItem).not.toHaveBeenCalled();
  });

  it("(e) a guest item the Cart did not mark but the quote refuses: the round's lines come out once and staff decide", async () => {
    const f = setup();
    // The Cart's marks could not be read (fail-open): everything shows as available.
    const table = sharedCart(
      f,
      guestsAtTable().map((line) => ({ ...line, standing: "Available" as const })),
    );
    table.unsellable.add(plum);
    f.pipeline.quote.mockResolvedValueOnce({
      status: "ItemUnavailable",
      cartItemReference: plum,
      reason: "Unavailable",
    } as never);
    const refused = await f.send(including([])).catch((error: unknown) => error);
    expect(refused).toMatchObject({
      code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
      pendingItems: [
        { cartItemReference: plum, standing: "Unavailable" },
        { cartItemReference: noodles, standing: "Available" },
      ],
      tableCart: { cartVersion: 5 },
    });
    // Exactly the round's own line was taken out, once; the guests' Cart is as it was.
    expect(table.removeItems).toHaveBeenCalledTimes(1);
    expect(table.removeItems).toHaveBeenCalledWith(guest, {
      cartReference: id(6),
      cartVersion: 4,
      cartItemReferences: [...table.staffLines],
    });
    expect(table.cart.lines.map((line) => line.cartItemReference)).toEqual([plum, noodles]);
    expect(f.pipeline.startCheckout).not.toHaveBeenCalled();
    expect(f.onUnexpected).not.toHaveBeenCalled();
    // Staff remove it: the owner decides at that instant (the Cart still shows it available).
    const again = await f.send({ operationReference: fresh(), ...including([plum], 5) });
    expect(again).toMatchObject({ status: "Placed" });
    expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles", "Sliced potato"]);
  });

  const deciding = (lines: Record<string, unknown>[], expectedCartVersion = 3) => ({
    includeTableCart: { expectedCartVersion, lines },
  });

  it("M35: staff send one guest line and take another out, in one atomic removal of their own", async () => {
    const f = setup();
    const table = sharedCart(f, [
      { cartItemReference: plum, name: "Plum juice", quantity: 1, standing: "Available" },
      { cartItemReference: noodles, name: "Noodles", quantity: 2, standing: "Available" },
    ]);
    const placed = await f.send(
      deciding([
        { cartItemReference: plum, decision: "Remove" },
        { cartItemReference: noodles, decision: "Send" },
      ]),
    );
    expect(placed).toMatchObject({ status: "Placed" });
    // The guest asked (the default reason): recorded as the staff member's removal.
    expect(table.staffRemoval.mock.calls[0]?.[0]).toMatchObject({
      expectedCartVersion: 3,
      keep: [noodles],
      lines: [{ cartItemReference: plum, reason: "GuestAsked" }],
    });
    expect(table.removeItems).not.toHaveBeenCalled();
    expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles", "Sliced potato"]);
    // A phone that left: the reason staff gave is kept.
    const g = setup();
    const left = sharedCart(g, guestsAtTable());
    await g.send({
      operationReference: fresh(),
      ...deciding([
        { cartItemReference: plum, decision: "Remove", reason: "CantMake" },
        { cartItemReference: noodles, decision: "Remove", reason: "GuestLeft" },
      ]),
    });
    expect(left.staffRemoval.mock.calls[0]?.[0]).toMatchObject({
      keep: [],
      lines: [
        { cartItemReference: plum, reason: "CantMake" },
        { cartItemReference: noodles, reason: "GuestLeft" },
      ],
    });
  });

  it("M35: staff send only the guests' lines (no dish of their own), and only when one is sent", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    const placed = await f.send({
      lines: [],
      ...deciding([
        { cartItemReference: plum, decision: "Remove", reason: "CantMake" },
        { cartItemReference: noodles, decision: "Send" },
      ]),
    });
    expect(placed).toMatchObject({ status: "Placed" });
    expect(f.pipeline.addItem).not.toHaveBeenCalled();
    expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles"]);
    expect(f.pipeline.quote).toHaveBeenCalledWith(
      guest,
      expect.objectContaining({ cartVersion: 4 }),
    );
    // Nothing sent at all is not a round.
    for (const include of [
      undefined,
      deciding([
        { cartItemReference: plum, decision: "Remove" },
        { cartItemReference: noodles, decision: "Remove" },
      ]).includeTableCart,
    ])
      await expect(
        f.send({
          operationReference: fresh(),
          lines: [],
          ...(include === undefined ? {} : { includeTableCart: include }),
        }),
      ).rejects.toMatchObject({ code: "STAFF_ROUND_INPUT_INVALID" });
  });

  it("M35: decisions for a cart that moved on are refused before the table is opened, with nothing recorded", async () => {
    const f = setup();
    sharedCart(f, guestsAtTable());
    // The read-only check sees the table's cart at version 4 with a third line.
    state.tableCart = {
      cartReference: id(6),
      cartVersion: 4,
      lines: [
        { cartItemReference: plum, sellableReference: id(81), quantity: 1 },
        { cartItemReference: noodles, sellableReference: id(82), quantity: 2 },
        { cartItemReference: id(64), sellableReference: id(83), quantity: 1 },
      ],
    };
    for (const command of [
      deciding([
        { cartItemReference: plum, decision: "Remove" },
        { cartItemReference: noodles, decision: "Send" },
      ]),
      deciding(
        [
          { cartItemReference: plum, decision: "Remove" },
          { cartItemReference: noodles, decision: "Send" },
        ],
        4,
      ),
      // Not deciding at all: also refused at once.
      {},
    ])
      await expect(f.send({ operationReference: fresh(), ...command })).rejects.toMatchObject({
        code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
        pendingItems: [
          { cartItemReference: plum },
          { cartItemReference: noodles },
          { cartItemReference: id(64) },
        ],
        tableCart: { cartVersion: 4 },
      });
    expect(f.calls).not.toContain("openTable");
    expect(f.calls).not.toContain("join");
    expect(state.entries.size).toBe(0);
    expect(state.staffRemovals).toHaveLength(0);
  });

  it("M35: a line that can't be sold now is never sent, and a line the cart no longer holds is refused", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    await expect(
      f.send(
        deciding([
          { cartItemReference: plum, decision: "Send" },
          { cartItemReference: noodles, decision: "Send" },
        ]),
      ),
    ).rejects.toMatchObject({
      code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
      pendingItems: [
        { cartItemReference: plum, standing: "Unavailable" },
        { cartItemReference: noodles, standing: "Available" },
      ],
    });
    // Only some of the lines decided on: refused, nothing removed.
    await expect(
      f.send({
        operationReference: fresh(),
        ...deciding([{ cartItemReference: plum, decision: "Remove" }]),
      }),
    ).rejects.toMatchObject({ code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS" });
    expect(table.staffRemoval).not.toHaveBeenCalled();
    expect(f.pipeline.addItem).not.toHaveBeenCalled();
  });

  it("M35: while a guest pays for the cart staff are told so; a removal that can't be confirmed sends nothing", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    table.staffRemoval.mockRejectedValueOnce(new CartError("CART_CHECKOUT_IN_PROGRESS"));
    const remove = deciding([
      { cartItemReference: plum, decision: "Remove" },
      { cartItemReference: noodles, decision: "Send" },
    ]);
    await expect(f.send(remove)).rejects.toMatchObject({
      code: "STAFF_ROUND_TABLE_CHECKOUT_IN_PROGRESS",
    });
    table.staffRemoval.mockRejectedValueOnce(new CartError("CART_DEPENDENCY_UNAVAILABLE"));
    await expect(f.send({ operationReference: fresh(), ...remove })).rejects.toMatchObject({
      code: "STAFF_ROUND_UNAVAILABLE",
    });
    expect(f.pipeline.addItem).not.toHaveBeenCalled();
    expect(table.cart.lines).toHaveLength(2);
  });

  it("M35: a removal is the round command's own: its references come from the command and the line, and a retry after a lost answer never asks staff to decide again", async () => {
    const f = setup();
    const table = sharedCart(f, guestsAtTable());
    const operationReference = "019a6f00-1234-7abc-8def-000000000123";
    const remove = {
      operationReference,
      ...deciding([
        { cartItemReference: plum, decision: "Remove" },
        { cartItemReference: noodles, decision: "Send" },
      ]),
    };
    // The removal commits; the next step's answer is lost.
    f.pipeline.quote.mockRejectedValueOnce(new Error("connection reset"));
    await expect(f.send(remove)).rejects.toMatchObject({ code: "STAFF_ROUND_UNAVAILABLE" });
    const call = table.staffRemoval.mock.calls[0]?.[0] as unknown as {
      lines: {
        cartItemReference: string;
        operationReference: string;
        audit: { auditId: string };
      }[];
    };
    const line = call.lines[0];
    expect(line?.operationReference).toBe(
      staffRemovalReference(operationReference, plum, "Operation"),
    );
    expect(line?.audit.auditId).toBe(staffRemovalReference(operationReference, plum, "Audit"));
    // UUIDv7 dated as the command, the same for the same command and line, never another's.
    expect(line?.operationReference).toMatch(
      /^019a6f00-1234-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(staffRemovalReference(operationReference, noodles, "Operation")).not.toBe(
      line?.operationReference,
    );
    expect(staffRemovalReference(id(0x901), plum, "Operation")).not.toBe(line?.operationReference);
    expect(line?.audit.auditId).not.toBe(line?.operationReference);
    // The same command again: the round it started, never "decide on the guests' lines again".
    await expect(f.send(remove)).rejects.toMatchObject({ code: "STAFF_ROUND_IN_PROGRESS" });
    expect(table.staffRemoval).toHaveBeenCalledTimes(1);
    expect(table.cart.lines.map((entry) => entry.name)).toEqual(["Noodles"]);
  });

  it("M35: the decisions are part of the command; a malformed decision is not a command", async () => {
    const f = setup();
    sharedCart(f, guestsAtTable());
    const operationReference = fresh();
    await f.send({
      operationReference,
      ...deciding([
        { cartItemReference: plum, decision: "Remove" },
        { cartItemReference: noodles, decision: "Send" },
      ]),
    });
    await expect(
      f.send({
        operationReference,
        ...deciding([
          { cartItemReference: plum, decision: "Remove" },
          { cartItemReference: noodles, decision: "Remove" },
        ]),
      }),
    ).rejects.toMatchObject({ code: "STAFF_ROUND_IDEMPOTENCY_CONFLICT" });
    for (const include of [
      { expectedCartVersion: 3, lines: [] },
      { expectedCartVersion: 3, lines: [{ cartItemReference: plum, decision: "Later" }] },
      {
        expectedCartVersion: 3,
        lines: [{ cartItemReference: plum, decision: "Send", reason: "GuestAsked" }],
      },
      {
        expectedCartVersion: 3,
        lines: [{ cartItemReference: plum, decision: "Remove", reason: "Because" }],
      },
      {
        expectedCartVersion: 3,
        lines: [
          { cartItemReference: plum, decision: "Send" },
          { cartItemReference: plum, decision: "Remove" },
        ],
      },
      {
        expectedCartVersion: 3,
        lines: [{ cartItemReference: plum, decision: "Send" }],
        removeUnavailable: [],
      },
    ])
      expect(() =>
        parseStaffDiningRoundCommand({
          operationReference: fresh(),
          tableReference: table,
          lines: [{ sellableReference: id(2), quantity: 1, optionSelections: [], note: null }],
          tip: { kind: "None" },
          recordedAfterOutage: false,
          includeTableCart: include,
        }),
      ).toThrow(StaffDiningRoundError);
  });

  it("(f) the round's own line refused by the quote is named; the guests' items stay", async () => {
    for (const [reason, optionsChanged] of [
      ["Unavailable", false],
      ["OptionsChanged", true],
    ] as const) {
      state.entries.clear();
      const f = setup();
      const table = sharedCart(f, [
        { cartItemReference: noodles, name: "Noodles", quantity: 2, standing: "Available" },
      ]);
      f.pipeline.quote.mockImplementationOnce((async () => ({
        status: "ItemUnavailable",
        cartItemReference: [...table.staffLines][0],
        reason,
      })) as never);
      await expect(f.send(including())).rejects.toMatchObject({
        code: "STAFF_ROUND_ITEM_UNAVAILABLE",
        lineIndex: 0,
        optionsChanged,
      });
      expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles"]);
      expect(f.onUnexpected).not.toHaveBeenCalled();
    }
  });

  it("(g) the checkout finds a guest item short: staff are told how many are left, the round's line out", async () => {
    for (const available of [2, 0]) {
      state.entries.clear();
      const f = setup();
      const table = sharedCart(f, [
        { cartItemReference: noodles, name: "Noodles", quantity: 3, standing: "Available" },
      ]);
      f.pipeline.startCheckout.mockResolvedValueOnce({
        status: "ItemShort",
        cartItemReference: noodles,
        available,
        sharedStock: false,
      } as never);
      await expect(f.send(including())).rejects.toMatchObject({
        code: "STAFF_ROUND_TABLE_CART_HAS_ITEMS",
        pendingItems: [{ cartItemReference: noodles, standing: "Short", available }],
        tableCart: { cartVersion: 5 },
      });
      expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles"]);
      expect(f.pipeline.preparePayment).not.toHaveBeenCalled();
    }
    // The round's own line short, with guests' lines in the Cart: still named by its line.
    state.entries.clear();
    const f = setup();
    const table = sharedCart(f, [
      { cartItemReference: noodles, name: "Noodles", quantity: 3, standing: "Available" },
    ]);
    f.pipeline.startCheckout.mockImplementationOnce((async () => ({
      status: "ItemShort",
      cartItemReference: [...table.staffLines][0],
      available: 1,
      sharedStock: false,
    })) as never);
    await expect(f.send(including())).rejects.toMatchObject({
      code: "STAFF_ROUND_STOCK_SHORT",
      lineIndex: 0,
      available: 1,
    });
    expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles"]);
  });

  it("(h) a guest edit after the round's lines went in: they are still taken out of the Cart", async () => {
    const f = setup();
    const table = sharedCart(f, [
      { cartItemReference: noodles, name: "Noodles", quantity: 2, standing: "Available" },
    ]);
    f.pipeline.quote.mockImplementationOnce((async () => {
      // A guest changes the noodles meanwhile: the quote finds another Cart version.
      table.cart.lines = table.cart.lines.map((line) =>
        line.cartItemReference === noodles ? { ...line, quantity: 3 } : line,
      );
      table.cart.version += 1;
      return { status: "NotPriced" };
    }) as never);
    await expect(f.send(including())).rejects.toMatchObject({ code: "STAFF_ROUND_NOT_PRICED" });
    expect(table.removeItems).toHaveBeenCalledTimes(2);
    expect(table.removeItems).toHaveBeenLastCalledWith(guest, {
      cartReference: id(6),
      cartVersion: 5,
      cartItemReferences: [...table.staffLines],
    });
    expect(table.cart.lines.map((line) => line.name)).toEqual(["Noodles"]);
    expect(f.onUnexpected).not.toHaveBeenCalled();
  });
});
