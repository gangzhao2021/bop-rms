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
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresStaffDiningRoundEntryStore: vi.fn(() => ({
    listAwaitingPaymentByTables: mock.awaiting,
  })),
  listStoreDiningSessionOrders: mock.sessionOrders,
  listStoreUnpaidGuestDiningRounds: mock.unpaidGuestRounds,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresCardMachinePaymentStore: vi.fn(() => ({ listByBatches: mock.cardPaid })),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: mock.store,
  createPostgresDiningSessionReadStore: vi.fn(() => ({ loadSessions: mock.loadSessions })),
  createPostgresDiningTableQrStore: vi.fn(() => ({ loadLatestForTables: mock.codes })),
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
  f.authorizeAction.mockImplementation(async (action?: string) => ({
    effect: action === "ordering.order.cancel" ? "Deny" : "Allow",
  }));
  expect((await f.read(f.input)).canCancelUnpaidRounds).toBe(false);
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
  // Without the closing permission (Front of House): nothing to close with, no Order looked up.
  f.authorizeAction.mockImplementation(async (action?: unknown) => ({
    effect: action === "dining.session.close" ? "Deny" : "Allow",
  }));
  mock.sessionOrders.mockClear();
  const denied = await f.read(f.input);
  expect(denied.canCloseSessions).toBe(false);
  expect(mock.sessionOrders).not.toHaveBeenCalled();
  expect(denied.items[0]?.session).toEqual({ phase: "Active", version: 3, orderReference: null });
});

it("WP-2423: offers the Order host section only to staff who may transfer the host", async () => {
  const f = setup();
  expect((await f.read(f.input)).canTransferHost).toBe(true);
  f.authorizeAction.mockImplementation(async (action?: unknown) => ({
    effect: action === "dining.host.transfer" ? "Deny" : "Allow",
  }));
  expect((await f.read(f.input)).canTransferHost).toBe(false);
});
