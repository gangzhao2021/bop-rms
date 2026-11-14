import { beforeEach, expect, it, vi } from "vitest";

const listTables = vi.hoisted(() => vi.fn());
vi.mock("@rms/dining", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: () => ({ listTables }),
  createPostgresDiningSessionReadStore: () => ({ loadSessions: vi.fn(async () => []) }),
}));
const { readTonightFacts } = await import("./merchant-tonight-summary.js");

const id = (n: number) => "01a0f0b0-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const input = {
  scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
  window: { startsAt: "2026-11-13T09:00:00.000Z", endsAt: "2026-11-14T09:00:00.000Z" },
  observedAt: "2026-11-13T20:00:00.000Z",
  ledger: {} as never,
  authorize: async () => true,
};
beforeEach(() => vi.clearAllMocks());

/**
 * v15 b12 (tables-list-paging): tonight's open tables are read as the Tables page reads them —
 * tables in use, retired ones left out in the query — and a Store with more tables than are read
 * is said as not read, never as fewer open tables and less money still owed.
 */
it("reads the tables in use and refuses to answer from part of a very large Store", async () => {
  let page = 0;
  listTables.mockImplementation(async () => {
    page += 1;
    return { items: [], nextAfterTableReference: id(100 + page) };
  });
  await expect(readTonightFacts({ query: vi.fn() } as never, input)).rejects.toThrow(
    "MERCHANT_STORE_REPORTS_UNAVAILABLE",
  );
  expect(listTables).toHaveBeenCalledTimes(10);
  for (const [request] of listTables.mock.calls)
    expect(request).toMatchObject({ limit: 100, lifecycle: "InUse" });
  expect(listTables.mock.calls[1]?.[0]).toMatchObject({ afterTableReference: id(101) });
});
