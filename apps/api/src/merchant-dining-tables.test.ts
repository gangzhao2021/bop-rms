import { expect, it, vi, beforeEach } from "vitest";
import { createMerchantDiningTables } from "./merchant-dining-tables.js";
const mock = vi.hoisted(() => ({ resolve: vi.fn(), list: vi.fn(), store: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => mock.resolve }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: mock.store,
}));
const id = (n: number) => "01909988-0000-7000-8000-" + n.toString(16).padStart(12, "0");
type Options = Parameters<typeof createMerchantDiningTables>[0];
function setup() {
  const allowed = vi.fn(async () => true),
    tx = { query: vi.fn() },
    authorize = vi.fn(async () => ({ sessionReference: id(9) }));
  mock.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    allowed,
  });
  mock.store.mockReturnValue({ listTables: mock.list });
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
    tx,
    authorize,
    read: createMerchantDiningTables({
      persistence: {
        transactions: { run: async (work: (tx: unknown) => unknown) => work(tx) },
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
  expect(mock.resolve).toHaveBeenCalledWith(f.tx, "synthetic", "dining.session.manage", id(9));
  expect(mock.store.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
  });
  expect(view.items[0]).not.toHaveProperty("privateField");
  expect(mock.list).toHaveBeenCalledWith(
    expect.objectContaining({ afterTableReference: null, limit: 10 }),
  );
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
