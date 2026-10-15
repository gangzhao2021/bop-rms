import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
const mocks = vi.hoisted(() => ({
  cancelled: vi.fn(),
  progress: vi.fn(),
  list: vi.fn(),
  carried: vi.fn(),
}));
const id = (n: number) => `0190ee39-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
vi.mock("./dining-order-delivery-progress.js", () => ({
  createDiningOrderDeliveryProgress: () => ({ load: mocks.progress }),
}));
vi.mock("@rms/ordering", () => ({
  parseOrderingInstant: (value: string) => value,
  createPostgresMerchantOrderIndex: () => ({ list: mocks.list }),
  listStoreOrdersWithRoundsSince: mocks.carried,
  readOrderCreationQuoteVersion: async () => 2,
  createPostgresOrderAcceptanceReader: () => ({ loadByBatch: async () => null }),
  createPostgresOrderExecutionReader: vi.fn(),
  createPostgresDiningOrderItemStateReader: () => ({ load: async () => null }),
  createPostgresDiningOrderPreparationSource: () => ({ resolveCancelled: mocks.cancelled }),
  createPostgresOrderCreationQueryStore: () => ({
    withCurrentSubmission: async (ref: string, work: (...args: unknown[]) => unknown) =>
      work(
        {},
        {
          order: {
            // WP-2423 D4 tests: submission 1000+n belongs to Order n.
            orderReference: ref === id(6) ? id(4) : id(parseInt(ref.slice(-12), 16) - 1000),
            orderType: "DineIn",
            diningSessionReference: id(7),
            batches: [{ orderBatchReference: id(5) }],
          },
          guestSessionReference: id(8),
        },
      ),
  }),
}));
const indexItem = (n: number, businessDate = "2026-09-22") => ({
  orderReference: id(n),
  orderType: "DineIn",
  businessDate,
  initialBatchReference: id(5),
  initialSubmissionReference: n === 4 ? id(6) : id(1000 + n),
});
beforeEach(() => {
  mocks.cancelled.mockReset();
  mocks.progress.mockReset();
  mocks.carried.mockReset();
  mocks.list.mockReset();
  mocks.list.mockResolvedValue({ items: [indexItem(4)], nextAfterOrderReference: null });
});
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  sessionReference: id(9),
};
function read(authorize: () => Promise<typeof scope | null> = async () => scope) {
  return createMerchantOrderQueueRead({
    transactions: { run: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }) },
    authorize,
    quoteVersion: 1,
    now: () => "2026-09-22T00:00:00.000Z",
  })({ sessionCookie: "synthetic", afterOrderReference: null, limit: 50 });
}
it("shows owning cancelled phase/version without creating an actionable batch or querying serving", async () => {
  mocks.cancelled.mockResolvedValue({ phase: "Cancelled", orderVersion: 2 });
  const result = await read();
  expect(result.items[0]).toMatchObject({
    currentPhase: "Cancelled",
    currentVersion: 2,
    batches: [],
  });
  expect(mocks.progress).not.toHaveBeenCalled();
  expect(mocks.cancelled).toHaveBeenCalledWith(
    expect.objectContaining({
      brandReference: id(2),
      storeReference: id(3),
      orderReference: id(4),
      diningSessionReference: id(7),
    }),
  );
});
it("keeps unsupported missing state unresolved", async () => {
  mocks.cancelled.mockResolvedValue(null);
  expect((await read()).items[0]).toMatchObject({
    currentPhase: null,
    currentVersion: null,
    batches: [],
  });
});
it("does not conceal conflicting cancellation history", async () => {
  mocks.cancelled.mockRejectedValue(new Error("ORDER_TERMINATION_CONFLICT"));
  await expect(read()).rejects.toThrow("ORDER_TERMINATION_CONFLICT");
});

it("WP-2423: shares one confirmation across the readers and rechecks fully at the end", async () => {
  mocks.cancelled.mockResolvedValue({ phase: "Cancelled", orderVersion: 2 });
  const authorize = vi.fn(async () => scope);
  await read(authorize);
  // Admission and the final recheck (the mocked readers here do not call it; real readers share one).
  expect(authorize).toHaveBeenCalledTimes(2);
  let calls = 0;
  await expect(read(async () => (++calls === 2 ? null : scope))).rejects.toThrow();
});

it("WP-2423 D4: lists an older table's Order with a round today first, under today, and only once", async () => {
  mocks.cancelled.mockResolvedValue({ phase: "Cancelled", orderVersion: 2 });
  // Page: today's Order 12 and the Oct 11 table Order 4, which had a round today.
  mocks.list.mockImplementation(async (input: { onlyOrderReference?: string }) =>
    input.onlyOrderReference === id(4)
      ? { items: [indexItem(4, "2026-10-11")], nextAfterOrderReference: null }
      : {
          items: [indexItem(12, "2026-10-15"), indexItem(4, "2026-10-11")],
          nextAfterOrderReference: null,
        },
  );
  mocks.carried.mockResolvedValue([
    { orderReference: id(4), latestRoundAt: "2026-10-15T18:00:00.000Z" },
  ]);
  const today = vi.fn(async () => ({
    businessDate: "2026-10-15",
    startsAt: "2026-10-15T08:00:00.000Z",
  }));
  const run = (afterOrderReference: string | null) =>
    createMerchantOrderQueueRead({
      transactions: {
        run: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }),
      },
      authorize: async () => scope,
      quoteVersion: 1,
      now: () => "2026-10-15T19:00:00.000Z",
      today,
    })({ sessionCookie: "synthetic", afterOrderReference, limit: 50 });
  const first = await run(null);
  expect(
    first.items.map((item) => [item.orderReference, item.businessDate, item.listedBusinessDate]),
  ).toEqual([
    [id(4), "2026-10-11", "2026-10-15"],
    [id(12), "2026-10-15", "2026-10-15"],
  ]);
  expect(mocks.carried.mock.calls[0]?.[2]).toEqual({
    since: "2026-10-15T08:00:00.000Z",
    businessDate: "2026-10-15",
    limit: 100,
  });
  // A later page leaves it out: it is already listed with today's orders.
  const later = await run(id(20));
  expect(later.items.map((item) => item.orderReference)).toEqual([id(12)]);
});

it("WP-2423 D4: an unreadable business day never blanks the Orders page", async () => {
  mocks.cancelled.mockResolvedValue({ phase: "Cancelled", orderVersion: 2 });
  const queries: string[] = [];
  const result = await createMerchantOrderQueueRead({
    transactions: {
      run: async (work) =>
        work({
          query: async (sql: string) => {
            queries.push(sql);
            return { rows: [], rowCount: 0 };
          },
        }),
    },
    authorize: async () => scope,
    quoteVersion: 1,
    now: () => "2026-10-15T19:00:00.000Z",
    today: async () => {
      throw new Error("STORE_BUSINESS_DATE_UNAVAILABLE");
    },
  })({ sessionCookie: "synthetic", afterOrderReference: null, limit: 50 });
  expect(result.items.map((item) => [item.orderReference, item.listedBusinessDate])).toEqual([
    [id(4), "2026-09-22"],
  ]);
  expect(mocks.carried).not.toHaveBeenCalled();
  expect(queries).toContain("ROLLBACK TO SAVEPOINT merchant_round_business_date");
});
