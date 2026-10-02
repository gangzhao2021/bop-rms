import { expect, it, vi, beforeEach } from "vitest";
import { createMerchantDiningTables } from "./merchant-dining-tables.js";
const mock = vi.hoisted(() => ({
  resolve: vi.fn(),
  list: vi.fn(),
  store: vi.fn(),
  loadSessions: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: mock.store,
  createPostgresDiningSessionReadStore: vi.fn(() => ({ loadSessions: mock.loadSessions })),
}));
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningTables>[0];
function setup() {
  const allowed = vi.fn(async () => true),
    authorizeAction = vi.fn(async (): Promise<{ effect: "Allow" | "Deny" }> => ({
      effect: "Allow",
    })),
    tx = { query: vi.fn() },
    authorize = vi.fn(async () => ({ sessionReference: id(9) }));
  mock.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    allowed,
    authorizeAction,
  });
  mock.store.mockReturnValue({ listTables: mock.list });
  mock.loadSessions.mockResolvedValue([]);
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
  expect(f.authorizeAction).toHaveBeenCalledWith("dining.operate");
  expect(mock.list).toHaveBeenCalledWith(
    expect.objectContaining({ afterTableReference: null, limit: 10 }),
  );
});
it("exposes table operation controls only for the distinct dining.operate grant", async () => {
  const f = setup();
  f.authorizeAction.mockResolvedValueOnce({ effect: "Deny" });
  const view = await f.read(f.input);
  expect(view.items).toHaveLength(1);
  expect(view.canOperateTables).toBe(false);
  expect(mock.list).toHaveBeenCalledOnce();
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
  expect(f.allowed).toHaveBeenCalledTimes(3);
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
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
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
  f.allowed.mockResolvedValue(false);
  await expect(f.read(f.input)).rejects.toThrow();
  expect(mock.list).not.toHaveBeenCalled();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.input)).rejects.toThrow();
});
