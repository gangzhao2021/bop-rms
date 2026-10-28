import { expect, it, vi, beforeEach } from "vitest";
import { createMerchantDiningTables } from "./merchant-dining-tables.js";
const mock = vi.hoisted(() => ({
  resolve: vi.fn(),
  list: vi.fn(),
  store: vi.fn(),
  loadSessions: vi.fn(),
  codes: vi.fn(),
  awaiting: vi.fn(),
  cardPaid: vi.fn(),
  sessionOrders: vi.fn(),
  unpaidGuestRounds: vi.fn(),
  paidAwaitingAcceptance: vi.fn(),
  paidOnline: vi.fn(),
  staffCalls: vi.fn(),
  waitingRounds: vi.fn(),
  phones: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresStaffDiningRoundEntryStore: vi.fn(() => ({
    listAwaitingPaymentByTables: mock.awaiting,
  })),
  listStoreDiningSessionOrders: mock.sessionOrders,
  listStoreUnpaidGuestDiningRounds: mock.unpaidGuestRounds,
  listStorePaidDiningRoundsAwaitingAcceptance: mock.paidAwaitingAcceptance,
  createPostgresOrderRoundStaffHoldStore: vi.fn(() => ({ listWaiting: mock.waitingRounds })),
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresCardMachinePaymentStore: vi.fn(() => ({ listByBatches: mock.cardPaid })),
  listStoreOrderBatchesPaidOnline: mock.paidOnline,
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
const timing = vi.hoisted(() => ({
  store: "PayFirst" as "PayFirst" | "PayLater",
  sessions: new Map<string, "PayFirst" | "PayLater">(),
}));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: mock.store,
  createPostgresDiningSessionReadStore: vi.fn(() => ({ loadSessions: mock.loadSessions })),
  createPostgresDiningTableQrStore: vi.fn(() => ({ loadLatestForTables: mock.codes })),
  createPostgresDiningStaffCallStore: vi.fn(() => ({ listOpen: mock.staffCalls })),
  loadDiningSessionPhones: mock.phones,
  // DEC-DINE-IN-PAY-LATER: the Store opens tables pay first; no open table was opened otherwise.
  createPostgresDiningPaymentTimingStore: vi.fn(() => ({
    load: async () => ({ paymentTiming: timing.store }),
    loadSessionTimings: async (_tx: unknown, sessions: string[]) =>
      new Map(
        sessions.flatMap((s) => (timing.sessions.has(s) ? [[s, timing.sessions.get(s)]] : [])),
      ),
  })),
}));
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningTables>[0];
function setup() {
  const allowed = vi.fn(async () => true),
    authorizeAction = vi.fn<(action?: string) => Promise<{ effect: "Allow" | "Deny" }>>(
      async () => ({
        effect: "Allow",
      }),
    ),
    // One permission read answers every action the page needs (WP-2423 query budget).
    authorizeActions = vi.fn(
      async (actions: readonly string[]) =>
        new Map(
          await Promise.all(actions.map(async (a) => [a, await authorizeAction(a)] as const)),
        ),
    ),
    tx = { query: vi.fn() },
    authorize = vi.fn(async () => ({ sessionReference: id(9) }));
  mock.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    allowed,
    authorizeAction,
    authorizeActions,
  });
  mock.store.mockReturnValue({ listTables: mock.list });
  mock.loadSessions.mockResolvedValue([]);
  mock.codes.mockResolvedValue(new Map());
  mock.awaiting.mockResolvedValue([]);
  mock.cardPaid.mockResolvedValue(new Map());
  mock.sessionOrders.mockResolvedValue(new Map());
  mock.unpaidGuestRounds.mockResolvedValue([]);
  mock.paidAwaitingAcceptance.mockResolvedValue([]);
  mock.paidOnline.mockResolvedValue(new Set());
  mock.staffCalls.mockResolvedValue(new Map());
  mock.waitingRounds.mockResolvedValue([]);
  mock.phones.mockResolvedValue([]);
  mock.list.mockResolvedValue({
    items: [
      {
        tableReference: id(4),
        stableLabel: "T1",
        areaCode: "MAIN",
        capacity: 4,
        lifecycle: "Published",
        operationalState: "Available",
        aggregateVersion: 2,
        activeDiningSessionReference: null,
        privateField: "secret",
      },
    ],
    nextAfterTableReference: null,
  });
  return {
    allowed,
    authorizeAction,
    authorizeActions,
    tx,
    authorize,
    read: createMerchantDiningTables({
      tableAvailabilityCommandEnabled: true,
      persistence: {
        transactions: { run: async (work: (tx: unknown) => unknown) => work(tx) },
        now: () => "2026-09-25T12:00:00.000Z",
      } as unknown as Options["persistence"],
      authentication: { authorize } as unknown as Options["authentication"],
    }),
    input: {
      sessionCookie: "synthetic",
      csrf: "synthetic",
      query: { afterTableReference: null, limit: 10 },
    },
  };
}
beforeEach(() => vi.clearAllMocks());
it("uses current selected scope and projects only safe fields", async () => {
  const f = setup(),
    view = await f.read(f.input);
  expect(mock.resolve).toHaveBeenCalledWith(f.tx, "synthetic", "dining.operate", id(9));
  expect(mock.store.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
  });
  expect(view.items[0]).not.toHaveProperty("privateField");
  expect(view.items[0]?.elapsedMinutes).toBeNull();
  expect(view.canOperateTables).toBe(true);
  expect(f.authorizeActions).toHaveBeenCalledOnce();
  expect(f.authorizeAction).toHaveBeenCalledWith("dining.operate");
  expect(mock.list).toHaveBeenCalledWith(
    expect.objectContaining({ afterTableReference: null, limit: 10 }),
  );
});
it("refuses the page before any table read without the dining.operate grant", async () => {
  const f = setup();
  f.authorizeAction.mockImplementation(async (action?: unknown) => ({
    effect: action === "dining.operate" ? "Deny" : "Allow",
  }));
  await expect(f.read(f.input)).rejects.toThrow("DINING_TABLES_PERMISSION_DENIED");
  expect(mock.list).not.toHaveBeenCalled();
});
it("does not expose table command affordances when the BFF command is unconfigured", async () => {
  const f = setup();
  const read = createMerchantDiningTables({
    persistence: {
      transactions: { run: async (work: (tx: unknown) => unknown) => work(f.tx) },
      now: () => "2026-09-25T12:00:00.000Z",
    } as unknown as Options["persistence"],
    authentication: { authorize: f.authorize } as unknown as Options["authentication"],
  });
  expect((await read(f.input)).canOperateTables).toBe(false);
});
it("adds elapsed minutes from the current scoped Active Session", async () => {
  const f = setup();
  mock.list.mockResolvedValueOnce({
    items: [
      {
        tableReference: id(4),
        stableLabel: "T1",
        areaCode: "MAIN",
        capacity: 4,
        lifecycle: "Published",
        operationalState: "Available",
        aggregateVersion: 3,
        activeDiningSessionReference: id(5),
      },
    ],
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValueOnce([
    {
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      startedAt: "2026-09-25T11:42:00.000Z",
    },
  ]);
  const view = await f.read(f.input);
  expect(view.items[0]?.elapsedMinutes).toBe(18);
  expect(mock.loadSessions).toHaveBeenCalledWith([id(5)]);
  // WP-2423: resolved in full at the start (one read for all of the page's actions) and
  // re-checked in full once before the reply only.
  expect(f.authorizeActions).toHaveBeenCalledOnce();
  expect(f.allowed).toHaveBeenCalledOnce();
});
it("DEC-DINE-IN-PAY-LATER: says how each table pays — an open one as opened, a free one as the Store opens tables now", async () => {
  const f = setup();
  const table = (n: number, session: string | null) => ({
    tableReference: id(n),
    stableLabel: "T" + n,
    areaCode: "MAIN",
    capacity: 4,
    lifecycle: "Published",
    operationalState: "Available",
    aggregateVersion: 3,
    activeDiningSessionReference: session,
  });
  mock.list.mockResolvedValueOnce({
    items: [table(4, id(5)), table(6, null)],
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValueOnce([
    {
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      startedAt: "2026-09-25T11:42:00.000Z",
    },
  ]);
  timing.store = "PayLater";
  timing.sessions = new Map([[id(5), "PayFirst"]]);
  try {
    const view = await f.read(f.input);
    expect(view.items.map((item) => item.paymentTiming)).toEqual(["PayFirst", "PayLater"]);
  } finally {
    timing.store = "PayFirst";
    timing.sessions = new Map();
  }
});
it("does not return elapsed Session data if Store authority changes during the owner read", async () => {
  const f = setup();
  mock.list.mockResolvedValueOnce({
    items: [
      {
        tableReference: id(4),
        stableLabel: "T1",
        areaCode: "MAIN",
        capacity: 4,
        lifecycle: "Published",
        operationalState: "Available",
        aggregateVersion: 3,
        activeDiningSessionReference: id(5),
      },
    ],
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValueOnce([
    {
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      startedAt: "2026-09-25T11:42:00.000Z",
    },
  ]);
  // Allowed at the start; refused by the full re-check before the reply.
  f.allowed.mockResolvedValueOnce(false);
  await expect(f.read(f.input)).rejects.toThrow("DINING_TABLES_PERMISSION_DENIED");
  expect(mock.loadSessions).toHaveBeenCalledWith([id(5)]);
});
it.each([
  { limit: 101 },
  { limit: 0 },
  { afterTableReference: "invalid" },
  { storeReference: id(8) },
])("rejects invalid or injected selection %j", async (change) => {
  const f = setup();
  await expect(f.read({ ...f.input, query: { ...f.input.query, ...change } })).rejects.toThrow();
  expect(mock.list).not.toHaveBeenCalled();
});
it("denies before data read and on authority loss", async () => {
  const f = setup();
  f.authorizeAction.mockResolvedValueOnce(null as never);
  await expect(f.read(f.input)).rejects.toThrow();
  expect(mock.list).not.toHaveBeenCalled();
  f.allowed.mockResolvedValueOnce(false);
  await expect(f.read(f.input)).rejects.toThrow();
});
it("WP-2423 Q11: shows until when each table's current printed code works, or none", async () => {
  const f = setup();
  mock.list.mockResolvedValueOnce({
    items: [4, 5, 6].map((n) => ({
      tableReference: id(n),
      stableLabel: "T" + String(n),
      areaCode: "MAIN",
      capacity: 4,
      lifecycle: "Published",
      operationalState: "Available",
      aggregateVersion: 2,
      activeDiningSessionReference: null,
      qrStatus: n === 6 ? "Revoked" : "Active",
      qrVersion: 2,
    })),
    nextAfterTableReference: null,
  });
  mock.codes.mockResolvedValueOnce(
    new Map([
      [id(4), { qrVersion: 2, expiresAt: "2027-04-12T13:00:00.000Z" }],
      [id(5), { qrVersion: 1, expiresAt: "2027-01-01T00:00:00.000Z" }],
      [id(6), { qrVersion: 1, expiresAt: "2027-01-01T00:00:00.000Z" }],
    ]),
  );
  const view = await f.read(f.input);
  expect(mock.codes).toHaveBeenCalledWith([id(4), id(5), id(6)]);
  expect(view.items.map((item) => item.qrCodeValidUntil)).toEqual([
    "2027-04-12T13:00:00.000Z",
    null,
    null,
  ]);
});

it("WP-2423 item 5: lists the party's staff rounds still awaiting card-machine payment, with their deadline", async () => {
  const f = setup();
  mock.list.mockResolvedValueOnce({
    items: [4, 6].map((n) => ({
      tableReference: id(n),
      stableLabel: "T" + String(n),
      areaCode: "MAIN",
      capacity: 4,
      lifecycle: "Published",
      operationalState: "Available",
      aggregateVersion: 3,
      activeDiningSessionReference: id(n + 1),
    })),
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValueOnce(
    [5, 7].map((n) => ({
      diningSessionReference: id(n),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      startedAt: "2026-09-25T11:42:00.000Z",
    })),
  );
  const round = (table: number, session: number, batch: number, payBy: string) => ({
    tableReference: id(table),
    diningSessionReference: id(session),
    orderReference: id(40),
    orderBatchReference: id(batch),
    payBy,
  });
  mock.awaiting.mockResolvedValueOnce([
    round(4, 5, 41, "2026-09-25T12:10:00.000Z"),
    // Paid on the card machine but not yet seen by Ordering: not waiting.
    round(4, 5, 42, "2026-09-25T12:15:00.000Z"),
    // An earlier party's round at table 6 is not this party's.
    round(6, 99, 43, "2026-09-25T12:20:00.000Z"),
  ]);
  mock.cardPaid.mockResolvedValueOnce(new Map([[id(42), { cardMachinePaymentReference: id(44) }]]));
  const view = await f.read(f.input);
  expect(mock.awaiting.mock.calls[0]?.[1]).toEqual([id(4), id(6)]);
  // One Payment read for all of the party's rounds, whatever their number (no read per round).
  expect(mock.cardPaid).toHaveBeenCalledOnce();
  expect(mock.cardPaid.mock.calls[0]?.[1]).toEqual([
    { orderReference: id(40), orderBatchReference: id(41) },
    { orderReference: id(40), orderBatchReference: id(42) },
  ]);
  expect(view.items.map((item) => item.staffRoundsAwaitingPayment)).toEqual([
    [{ payBy: "2026-09-25T12:10:00.000Z" }],
    [],
  ]);
  expect(JSON.stringify(view)).not.toContain(id(41));
});

it("WP-2423 abandoned payment: lists each party's unpaid guest rounds and who may cancel them", async () => {
  const f = setup();
  const tables = {
    items: [4, 6].map((n) => ({
      tableReference: id(n),
      stableLabel: "T" + String(n),
      areaCode: "MAIN",
      capacity: 4,
      lifecycle: "Published",
      operationalState: "Available",
      aggregateVersion: 3,
      activeDiningSessionReference: id(n + 1),
    })),
    nextAfterTableReference: null,
  };
  const sessions = [5, 7].map((n) => ({
    diningSessionReference: id(n),
    brandReference: id(2),
    storeReference: id(3),
    phase: "Active",
    startedAt: "2026-09-25T11:42:00.000Z",
  }));
  mock.list.mockResolvedValueOnce(tables);
  mock.loadSessions.mockResolvedValueOnce(sessions);
  const unpaid = {
    diningSessionReference: id(5),
    orderReference: id(40),
    orderBatchReference: id(41),
    roundNumber: 1,
    payBy: "2026-09-25T12:10:00.000Z",
  };
  mock.unpaidGuestRounds.mockResolvedValueOnce([unpaid]);
  const view = await f.read(f.input);
  // One read for every open session on the page.
  expect(mock.unpaidGuestRounds).toHaveBeenCalledOnce();
  expect(mock.unpaidGuestRounds.mock.calls[0]?.[2]).toEqual([id(5), id(7)]);
  expect(view.items.map((item) => item.guestRoundsAwaitingPayment)).toEqual([
    [
      {
        orderReference: id(40),
        orderBatchReference: id(41),
        roundNumber: 1,
        payBy: "2026-09-25T12:10:00.000Z",
      },
    ],
    [],
  ]);
  expect(view.canCancelUnpaidRounds).toBe(true);
  expect(view.items.map((item) => item.roundsAwaitingAcceptance)).toEqual([[], []]);
  f.authorizeAction.mockImplementation(async (action?: string) => ({
    effect: action === "ordering.order.cancel" ? "Deny" : "Allow",
  }));
  expect((await f.read(f.input)).canCancelUnpaidRounds).toBe(false);
  // WP-2423 item 8 ①: only a manager who may approve refunds is offered a write-off.
  f.authorizeAction.mockImplementation(async (action?: string) => ({
    effect: action === "payment.refund.approve" ? "Deny" : "Allow",
  }));
  expect((await f.read(f.input)).canWriteOff).toBe(false);
  f.authorizeAction.mockImplementation(async () => ({ effect: "Allow" }));
  expect((await f.read(f.input)).canWriteOff).toBe(true);
  // A payment that just arrived (Payment recorded it, Ordering not yet): no longer unpaid, so no
  // "cancel unpaid round" for it. One Payment read for every listed round.
  mock.list.mockResolvedValueOnce(tables);
  mock.loadSessions.mockResolvedValueOnce(sessions);
  mock.unpaidGuestRounds.mockResolvedValueOnce([unpaid]);
  mock.paidOnline.mockResolvedValueOnce(new Set([id(41)]));
  const arrived = await f.read(f.input);
  expect(mock.paidOnline.mock.calls.at(-1)?.[2]).toEqual([id(41)]);
  expect(arrived.items.map((item) => item.guestRoundsAwaitingPayment)).toEqual([[], []]);
});

it("WP-2423 D4: gives each open session's phase, version and Order to staff who may close tables", async () => {
  const f = setup();
  mock.list.mockResolvedValue({
    items: [
      {
        tableReference: id(4),
        stableLabel: "T4",
        areaCode: "MAIN",
        capacity: 4,
        lifecycle: "Published",
        operationalState: "Available",
        aggregateVersion: 3,
        activeDiningSessionReference: id(5),
      },
    ],
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValue([
    {
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      version: 3,
      startedAt: "2026-09-25T11:42:00.000Z",
    },
  ]);
  mock.sessionOrders.mockResolvedValueOnce(new Map([[id(5), id(40)]]));
  const view = await f.read(f.input);
  expect(view.canCloseSessions).toBe(true);
  expect(f.authorizeAction).toHaveBeenCalledWith("dining.session.close");
  expect(f.authorizeAction).toHaveBeenCalledWith("order.close");
  expect(mock.sessionOrders.mock.calls[0]?.[2]).toEqual([id(5)]);
  expect(view.items[0]?.session).toEqual({ phase: "Active", version: 3, orderReference: id(40) });
  // Without the closing permission: nothing to close with, but the table's Order is still listed
  // (item 8 ①: the list shows each table's dishes and bill).
  f.authorizeAction.mockImplementation(async (action?: unknown) => ({
    effect: action === "dining.session.close" ? "Deny" : "Allow",
  }));
  mock.sessionOrders.mockClear();
  mock.sessionOrders.mockResolvedValueOnce(new Map([[id(5), id(40)]]));
  const denied = await f.read(f.input);
  expect(denied.canCloseSessions).toBe(false);
  expect(mock.sessionOrders).toHaveBeenCalledOnce();
  expect(denied.items[0]?.session).toEqual({ phase: "Active", version: 3, orderReference: id(40) });
});

it("WP-2423: offers the Order host section only to staff who may transfer the host", async () => {
  const f = setup();
  expect((await f.read(f.input)).canTransferHost).toBe(true);
  f.authorizeAction.mockImplementation(async (action?: unknown) => ({
    effect: action === "dining.host.transfer" ? "Deny" : "Allow",
  }));
  expect((await f.read(f.input)).canTransferHost).toBe(false);
});

it("WP-2423: lists each party's paid rounds still awaiting acceptance, with when each was paid", async () => {
  const f = setup();
  mock.list.mockResolvedValueOnce({
    items: [4, 6].map((n) => ({
      tableReference: id(n),
      stableLabel: "T" + String(n),
      areaCode: "MAIN",
      capacity: 4,
      lifecycle: "Published",
      operationalState: "Available",
      aggregateVersion: 3,
      activeDiningSessionReference: id(n + 1),
    })),
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValueOnce(
    [5, 7].map((n) => ({
      diningSessionReference: id(n),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      startedAt: "2026-09-25T11:42:00.000Z",
    })),
  );
  mock.paidAwaitingAcceptance.mockResolvedValueOnce([
    {
      diningSessionReference: id(7),
      orderReference: id(40),
      orderBatchReference: id(41),
      roundNumber: 2,
      paidAt: "2026-09-25T11:51:00.000Z",
    },
  ]);
  const view = await f.read(f.input);
  // One read for every open session on the page; no references reach the page.
  expect(mock.paidAwaitingAcceptance).toHaveBeenCalledOnce();
  expect(mock.paidAwaitingAcceptance.mock.calls[0]?.[2]).toEqual([id(5), id(7)]);
  expect(view.items.map((item) => item.roundsAwaitingAcceptance)).toEqual([
    [],
    [{ roundNumber: 2, paidAt: "2026-09-25T11:51:00.000Z" }],
  ]);
  expect(JSON.stringify(view)).not.toContain(id(41));
});
it("reads the polled Tables page in the composition's snapshot transaction when it has one", async () => {
  const f = setup();
  const run = vi.fn(async (work: (tx: unknown) => unknown) => work(f.tx)),
    runSnapshot = vi.fn(async (work: (tx: unknown) => unknown) => work(f.tx));
  const persistence = (transactions: object) =>
    ({ transactions, now: () => "2026-09-25T12:00:00.000Z" }) as unknown as Options["persistence"];
  const read = (transactions: object) =>
    createMerchantDiningTables({
      persistence: persistence(transactions),
      authentication: { authorize: f.authorize } as unknown as Options["authentication"],
    })(f.input);
  // WP-2423 (v15 2026-10-18): one read-only snapshot, never an ordinary (locking) transaction.
  expect((await read({ run, runSnapshot })).items).toHaveLength(1);
  expect(runSnapshot).toHaveBeenCalledOnce();
  expect(run).not.toHaveBeenCalled();
  expect(mock.list).toHaveBeenCalledOnce();
  // A composition without a snapshot transaction still reads, as an ordinary transaction.
  expect((await read({ run })).items).toHaveLength(1);
  expect(run).toHaveBeenCalledOnce();
});
it("WP-2423 Q28: shows the open call for staff at each open table, and none elsewhere", async () => {
  const f = setup();
  mock.list.mockResolvedValueOnce({
    items: [
      {
        tableReference: id(4),
        stableLabel: "T1",
        areaCode: "MAIN",
        capacity: 4,
        lifecycle: "Published",
        operationalState: "Available",
        aggregateVersion: 3,
        activeDiningSessionReference: id(5),
      },
      {
        tableReference: id(6),
        stableLabel: "T2",
        areaCode: "MAIN",
        capacity: 4,
        lifecycle: "Published",
        operationalState: "Available",
        aggregateVersion: 1,
        activeDiningSessionReference: null,
      },
    ],
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValueOnce([
    {
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      startedAt: "2026-09-25T11:42:00.000Z",
    },
  ]);
  mock.staffCalls.mockResolvedValueOnce(
    new Map([
      [
        id(5),
        {
          callReference: id(7),
          diningSessionReference: id(5),
          participantReference: id(8),
          reason: "TableNeeds",
          calledAt: "2026-09-25T11:55:00.000Z",
        },
      ],
    ]),
  );
  const view = await f.read(f.input);
  expect(mock.staffCalls).toHaveBeenCalledWith(expect.anything(), [id(5)], expect.any(Function));
  expect(view.items[0]?.staffCall).toEqual({
    callReference: id(7),
    reason: "TableNeeds",
    calledAt: "2026-09-25T11:55:00.000Z",
  });
  // Never the participant who called: staff go to the table.
  expect(JSON.stringify(view.items[0]?.staffCall)).not.toContain(id(8));
  expect(view.items[1]?.staffCall).toBeNull();
});

it("WP-2423 item 8 ⑤: a round waiting for staff needs action (not awaiting payment), and a phone that just joined is pointed out", async () => {
  const f = setup();
  mock.list.mockResolvedValueOnce({
    items: [
      {
        tableReference: id(4),
        stableLabel: "T4",
        areaCode: "MAIN",
        capacity: 4,
        lifecycle: "Published",
        operationalState: "Available",
        aggregateVersion: 3,
        activeDiningSessionReference: id(5),
      },
    ],
    nextAfterTableReference: null,
  });
  mock.loadSessions.mockResolvedValueOnce([
    {
      diningSessionReference: id(5),
      brandReference: id(2),
      storeReference: id(3),
      phase: "Active",
      startedAt: "2026-09-25T11:42:00.000Z",
    },
  ]);
  mock.sessionOrders.mockResolvedValueOnce(new Map([[id(5), id(40)]]));
  // The held round is also a submitted round nobody paid for: it is listed once, as waiting.
  mock.unpaidGuestRounds.mockResolvedValueOnce([
    {
      diningSessionReference: id(5),
      orderReference: id(40),
      orderBatchReference: id(41),
      roundNumber: 3,
      payBy: "2026-09-25T12:10:00.000Z",
    },
  ]);
  mock.waitingRounds.mockResolvedValueOnce([
    {
      orderReference: id(40),
      orderBatchReference: id(41),
      submissionReference: id(42),
      reason: "PhoneRapid",
      heldAt: "2026-09-25T11:58:00.000Z",
      release: null,
    },
  ]);
  mock.phones.mockResolvedValueOnce([
    {
      participantReference: id(60),
      phoneNumber: 1,
      joinedAt: "2026-09-25T11:43:00.000Z",
      left: false,
      removed: false,
    },
    {
      participantReference: id(61),
      phoneNumber: 2,
      joinedAt: "2026-09-25T11:56:00.000Z",
      left: false,
      removed: false,
    },
    {
      participantReference: id(62),
      phoneNumber: 3,
      joinedAt: "2026-09-25T11:57:00.000Z",
      left: true,
      removed: true,
    },
  ]);
  const [table] = (await f.read(f.input)).items;
  expect(table?.guestRoundsAwaitingPayment).toEqual([]);
  expect(table?.heldRounds).toEqual([
    {
      orderReference: id(40),
      orderBatchReference: id(41),
      roundNumber: 3,
      reason: "PhoneRapid",
      heldAt: "2026-09-25T11:58:00.000Z",
    },
  ]);
  // Joined in the last 10 minutes and still at the table (phone 3 was taken off it).
  expect(table?.newPhones).toEqual([{ phoneNumber: 2, joinedAt: "2026-09-25T11:56:00.000Z" }]);
});
