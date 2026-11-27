import { beforeEach, expect, it, vi } from "vitest";

const listTables = vi.hoisted(() => vi.fn());
const loadSessions = vi.hoisted(() => vi.fn(async (): Promise<unknown[]> => []));
vi.mock("@rms/dining", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/dining")>()),
  createPostgresDiningTableStore: () => ({ listTables }),
  createPostgresDiningSessionReadStore: () => ({ loadSessions }),
}));
const readDiningTableBill = vi.hoisted(() => vi.fn());
vi.mock("./merchant-dining-table-checkout.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./merchant-dining-table-checkout.js")>()),
  readDiningTableBill,
}));
vi.mock("@rms/ordering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/ordering")>()),
  listStoreCancelledDishes: async () => ({
    removedBeforePayment: { dishCount: 0, amountMinor: 0n },
    cancelledAfterPayment: { dishCount: 0, amountMinor: 0n },
    cancelledUnpaid: { roundCount: 0, dishCount: 0, amountMinor: 0n },
  }),
  listStoreOrderAutoAcceptanceEvents: async () => [],
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

/**
 * Batch 62 (v15 b61 live, TM2 table C61 A): every dish served and then comped by a manager, the
 * bill $0.00 and the table still open. Its own bill read is what tonight reads: the table is said
 * to be comped, never cancelled; a table whose only round was taken off stays cancelled.
 */
it("says a table comped to nothing by a manager is comped, from the table's own bill", async () => {
  const table = (n: number, label: string) => ({
    tableReference: id(10 + n),
    stableLabel: label,
    activeDiningSessionReference: id(20 + n),
  });
  listTables.mockResolvedValue({
    items: [table(1, "C61 A (TEST)"), table(2, "C61 F (TEST)")],
    nextAfterTableReference: null,
  });
  loadSessions.mockResolvedValue([{ startedAt: "2026-11-13T19:00:00.000Z" }]);
  const bill = (n: number, label: string, items: readonly unknown[]) => ({
    diningSessionReference: id(20 + n),
    sessionPhase: "Active",
    paymentTiming: "PayLater",
    tableLabel: label,
    orderReference: id(30 + n),
    rounds: [{ items }],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    settlement: null,
    writeOff: null,
    split: null,
  });
  readDiningTableBill.mockImplementation(
    async (_tx: unknown, _scope: unknown, request: { diningSessionReference: string }) =>
      request.diningSessionReference === id(21)
        ? bill(1, "C61 A (TEST)", [
            {
              orderItemReference: id(40),
              quantity: 3,
              displayName: "Beef noodles (TEST)",
              subtotalMinor: "0",
              totalMinor: "0",
              reduction: { kind: "Comp", percent: null, amountMinor: "4238", netMinor: "3750" },
            },
          ])
        : bill(2, "C61 F (TEST)", []),
  );
  const facts = await readTonightFacts({ query: vi.fn() } as never, input);
  expect(facts.openTables.map((open) => [open.tableLabel, open.standing])).toEqual([
    ["C61 A (TEST)", "Comped"],
    ["C61 F (TEST)", "NothingToCollect"],
  ]);
  expect(facts.openTablesOwedMinor).toBe("0");
});
