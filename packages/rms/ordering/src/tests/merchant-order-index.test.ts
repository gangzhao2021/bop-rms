import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresMerchantOrderIndex,
  listStoreKitchenOrderLabels,
  listStoreOrderRoundSubmissions,
  listStoreOrdersAwaitingAcceptance,
  listStoreOrdersWithRoundsSince,
  listStorePaidOrderBatches,
} from "../infrastructure/persistence/merchant-order-index.js";
import { listStoreDiningSessionOrders } from "../infrastructure/persistence/dining-session-order-lookup.js";
const id = (n: number) => "01909968-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const row = (n: number) => ({
  order_id: id(n),
  brand_id: scope.brandReference,
  store_id: scope.storeReference,
  order_number: "A-1",
  order_type: "Pickup",
  dining_session_id: null,
  guest_session_id: id(12),
  source_channel: "Web",
  created_at: new Date("2026-09-14T00:00:00.000Z"),
  // WP-2423 Q21: 20:00 on Sep 13 in Toronto — the Store's business date, not the UTC date.
  business_date: "2026-09-13",
  submission_id: id(10),
  order_batch_id: id(11),
});
function fixture(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.startsWith("SELECT h.") ? rows : [],
    rowCount: rows.length,
  }));
  return { query, tx: { query } as unknown as ConsumerTransaction };
}
it("paginates scoped identities without exposing initial version or private fields", async () => {
  const { tx, query } = fixture([row(3), row(4)]);
  const result = await createPostgresMerchantOrderIndex({
    ...scope,
    authorize: async () => true,
  }).list({ transaction: tx, limit: 1, afterOrderReference: null });
  expect(result.items).toHaveLength(1);
  expect(result.nextAfterOrderReference).toBe(id(3));
  expect(Object.keys(result.items[0] ?? {})).toEqual([
    "orderReference",
    "orderNumber",
    "orderType",
    "sourceChannel",
    "businessDate",
    "submittedAt",
    "initialSubmissionReference",
    "initialBatchReference",
  ]);
  expect(result.items[0]?.businessDate).toBe("2026-09-13");
  expect(query.mock.calls[1]?.[0]).toContain("h.business_date::text AS business_date");
  expect(query.mock.calls[1]?.[0]).toContain("h.brand_id=$1 AND h.store_id=$2");
});
it.each([
  { rows: [row(3), row(3)] },
  { rows: [{ ...row(3), store_id: id(8) }] },
  { rows: [{ ...row(3), business_date: null }] },
  { rows: [{ ...row(3), business_date: new Date("2026-09-13T00:00:00.000Z") }] },
])("rejects duplicate or foreign source rows", async ({ rows }) => {
  const { tx } = fixture(rows);
  await expect(
    createPostgresMerchantOrderIndex({ ...scope, authorize: async () => true }).list({
      transaction: tx,
      limit: 10,
      afterOrderReference: null,
    }),
  ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
});
it("rejects revoked access after reading", async () => {
  const { tx } = fixture([row(3)]);
  const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(
    createPostgresMerchantOrderIndex({ ...scope, authorize }).list({
      transaction: tx,
      limit: 10,
      afterOrderReference: null,
    }),
  ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
});
it("does no SQL for denied access or invalid limits", async () => {
  const { tx, query } = fixture([]);
  const store = createPostgresMerchantOrderIndex({ ...scope, authorize: async () => false });
  await expect(
    store.list({ transaction: tx, limit: 101, afterOrderReference: null }),
  ).rejects.toThrow();
  await expect(
    store.list({ transaction: tx, limit: 1, afterOrderReference: null }),
  ).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

it("finds only the scoped exact Order and initial submission identity", async () => {
  const { tx, query } = fixture([row(3)]);
  const result = await createPostgresMerchantOrderIndex({
    ...scope,
    authorize: async () => true,
  }).find({ transaction: tx, orderReference: id(3) });
  expect(result).toEqual({
    orderReference: id(3),
    orderType: "Pickup",
    diningSessionReference: null,
    guestSessionReference: id(12),
    initialSubmissionReference: id(10),
    initialBatchReference: id(11),
  });
  expect(query.mock.calls[1]?.[0]).toContain("h.order_id=$3 LIMIT 2");
});
it.each([
  [row(3), row(3)],
  [row(4)],
  [{ ...row(3), brand_id: id(8) }],
  [{ ...row(3), order_type: "Other" }],
])("rejects ambiguous or mismatched exact discovery %j", async (...rows) => {
  const { tx } = fixture(rows);
  await expect(
    createPostgresMerchantOrderIndex({ ...scope, authorize: async () => true }).find({
      transaction: tx,
      orderReference: id(3),
    }),
  ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
});
it("does not read denied exact discovery or disclose missing data after revocation", async () => {
  const { tx, query } = fixture([]);
  const authorize = vi.fn(async () => false);
  const store = createPostgresMerchantOrderIndex({ ...scope, authorize });
  await expect(store.find({ transaction: tx, orderReference: id(3) })).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(store.find({ transaction: tx, orderReference: id(3) })).rejects.toThrow();
  authorize.mockResolvedValue(true);
  expect(await store.find({ transaction: tx, orderReference: id(3) })).toBeNull();
});

it("resolves original Dining context from owner fields", async () => {
  const { tx } = fixture([{ ...row(3), order_type: "DineIn", dining_session_id: id(13) }]);
  expect(
    await createPostgresMerchantOrderIndex({ ...scope, authorize: async () => true }).find({
      transaction: tx,
      orderReference: id(3),
    }),
  ).toMatchObject({ diningSessionReference: id(13), guestSessionReference: id(12) });
});
it("WP-2423: lists the newest Orders first and pages back to older ones", async () => {
  const { tx, query } = fixture([row(5), row(4), row(3)]);
  const result = await createPostgresMerchantOrderIndex({
    ...scope,
    authorize: async () => true,
  }).list({ transaction: tx, limit: 2, afterOrderReference: id(6), newestFirst: true });
  expect(result.items.map((item) => item.orderReference)).toEqual([id(5), id(4)]);
  expect(result.nextAfterOrderReference).toBe(id(4));
  const sql = String(query.mock.calls[1]?.[0]);
  expect(sql).toContain("h.order_id<$3::uuid");
  expect(sql).toContain("ORDER BY h.order_id DESC");
  const { tx: wrong } = fixture([row(3), row(4)]);
  await expect(
    createPostgresMerchantOrderIndex({ ...scope, authorize: async () => true }).list({
      transaction: wrong,
      limit: 10,
      afterOrderReference: null,
      newestFirst: true,
    }),
  ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
});
it("WP-2423: reads the Store's order numbers for given Orders", async () => {
  const { tx, query } = fixture([]);
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("order_number FROM")
      ? [
          { order_id: id(3), order_number: "15" },
          { order_id: id(4), order_number: null },
        ]
      : [],
    rowCount: 0,
  }));
  const { listStoreOrderNumbers } =
    await import("../infrastructure/persistence/merchant-order-index.js");
  const numbers = await listStoreOrderNumbers(tx, scope, [id(3), id(4)]);
  expect([...numbers]).toEqual([[id(3), "15"]]);
  expect(String(query.mock.calls[1]?.[0])).toContain("brand_id=$1 AND store_id=$2");
  expect((await listStoreOrderNumbers(tx, scope, [])).size).toBe(0);
});
it("WP-2423: names only the given Orders of the Store that staff took at the counter", async () => {
  const { tx, query } = fixture([]);
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("source_channel='Pos'") ? [{ order_id: id(3) }, { order_id: id(9) }] : [],
    rowCount: 0,
  }));
  const { listStoreCounterOrders } =
    await import("../infrastructure/persistence/merchant-order-index.js");
  const counter = await listStoreCounterOrders(tx, scope, [id(3), id(4)]);
  // A row for an Order that was not asked about is never reported.
  expect([...counter]).toEqual([id(3)]);
  expect(String(query.mock.calls[1]?.[0])).toContain("brand_id=$1 AND store_id=$2");
  expect((query.mock.calls[1] as unknown[] | undefined)?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    [id(3), id(4)],
  ]);
  expect((await listStoreCounterOrders(tx, scope, [])).size).toBe(0);
  await expect(listStoreCounterOrders(tx, scope, ["not-a-reference"])).rejects.toThrow();
});
it("WP-2423: reads one Order of the Store for its detail", async () => {
  const { tx, query } = fixture([row(4)]);
  const result = await createPostgresMerchantOrderIndex({
    ...scope,
    authorize: async () => true,
  }).list({
    transaction: tx,
    limit: 1,
    afterOrderReference: null,
    newestFirst: true,
    onlyOrderReference: id(4),
  });
  expect(result.items.map((item) => item.orderReference)).toEqual([id(4)]);
  expect(String(query.mock.calls[1]?.[0])).toContain("h.order_id=$5::uuid");
  expect((query.mock.calls[1] as unknown[] | undefined)?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    null,
    2,
    id(4),
    [],
  ]);
});
it("WP-2423 (2026-10-16): leaves out Orders listed elsewhere so a page keeps its full size", async () => {
  const { tx, query } = fixture([row(5), row(3)]);
  const index = createPostgresMerchantOrderIndex({ ...scope, authorize: async () => true });
  const result = await index.list({
    transaction: tx,
    limit: 1,
    afterOrderReference: null,
    newestFirst: true,
    excludeOrderReferences: [id(4)],
  });
  expect(result.items.map((item) => item.orderReference)).toEqual([id(5)]);
  expect(result.nextAfterOrderReference).toBe(id(5));
  expect(String(query.mock.calls[1]?.[0])).toContain("NOT (h.order_id=ANY($6::uuid[]))");
  expect((query.mock.calls[1] as unknown[] | undefined)?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    null,
    2,
    null,
    [id(4)],
  ]);
  // A source row for an Order that was left out is a broken answer, never listed twice.
  const leaked = fixture([row(4)]);
  await expect(
    index.list({
      transaction: leaked.tx,
      limit: 1,
      afterOrderReference: null,
      newestFirst: true,
      excludeOrderReferences: [id(4)],
    }),
  ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
});
it("WP-2423: reads an Order's lines with option names, notes and totals", async () => {
  const { configuredOrderItemFixture } = await import("./configured-order-item.fixture.js");
  const { encodeConfiguredOrderItemSnapshot } =
    await import("../domain/order-item-snapshot-codec.js");
  const { loadMerchantOrderLines } =
    await import("../infrastructure/persistence/merchant-order-index.js");
  const { item } = await configuredOrderItemFixture();
  const wire = JSON.parse(encodeConfiguredOrderItemSnapshot(item));
  const { tx, query } = fixture([]);
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM rms_ordering.order_item")
      ? [
          { transaction_snapshot_json: wire, quote_version: "2" },
          { transaction_snapshot_json: wire, quote_version: "2" },
        ]
      : [],
    rowCount: 0,
  }));
  const lines = await loadMerchantOrderLines(tx, scope, id(3), "en-CA");
  expect(lines?.items).toHaveLength(2);
  expect(lines?.items[0]?.options).toEqual([
    { name: "Synthetic option", quantity: item.catalog.options[0]?.quantity },
  ]);
  expect(lines?.items[0]?.total).toEqual({ amountMinor: "2825", currencyCode: "CAD" });
  expect(lines?.totals.total).toEqual({ amountMinor: "5650", currencyCode: "CAD" });
  expect(String(query.mock.calls[1]?.[0])).toContain("i.brand_id=$1 AND i.store_id=$2");
  query.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  expect(await loadMerchantOrderLines(tx, scope, id(3), "en-CA")).toBeNull();
});
it("WP-2423: lists the Store's paid Orders that can no longer be fulfilled", async () => {
  const { tx, query } = fixture([]);
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("order_payment_disposition_record")
      ? [
          { order_id: id(3), reason: "CapacityExpired" },
          { order_id: id(4), reason: "Invented" },
        ]
      : [],
    rowCount: 0,
  }));
  const { listStoreUnfulfillablePaidOrders } =
    await import("../infrastructure/persistence/merchant-order-index.js");
  const found = await listStoreUnfulfillablePaidOrders(tx, scope, [id(3), id(4)]);
  expect([...found]).toEqual([[id(3), "CapacityExpired"]]);
  const sql = String(query.mock.calls[1]?.[0]);
  expect(sql).toContain("disposition='PaidWithoutFulfillableOrder'");
  expect(sql).toContain("brand_id=$1 AND store_id=$2");
  expect((await listStoreUnfulfillablePaidOrders(tx, scope, [])).size).toBe(0);
});
it("WP-2423 Q1: reads recorded payments and batches awaiting acceptance for the scoped Orders", async () => {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>(
    async (sql) => ({
      rows: sql.startsWith("SELECT set_config")
        ? []
        : [
            {
              order_id: id(3),
              order_batch_id: id(13),
              awaiting: true,
              since: "2026-10-16T14:50:00.000Z",
            },
            { order_id: id(4), order_batch_id: id(14), awaiting: false, since: null },
          ],
      rowCount: 2,
    }),
  );
  const tx = { query } as unknown as ConsumerTransaction;
  const result = await listStorePaidOrderBatches(tx, scope, [id(3), id(4), id(5)]);
  expect([...result.paidOrders]).toEqual([id(3), id(4)]);
  expect([...result.awaitingAcceptance]).toEqual([id(13)]);
  expect([...result.paidBatches]).toEqual([id(13), id(14)]);
  // WP-2423: when each batch awaiting acceptance was recorded as paid (the staff wait warning).
  expect([...result.awaitingSince]).toEqual([[id(13), "2026-10-16T14:50:00.000Z"]]);
  expect(query.mock.calls[1]?.[0]).toContain("order_payment_acceptance_wait");
  expect(query.mock.calls[1]?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    [id(3), id(4), id(5)],
  ]);
  // A row for an Order that was not asked for is a scope failure, not data.
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
    rows: [
      {
        order_id: id(9),
        order_batch_id: id(19),
        awaiting: true,
        since: "2026-10-16T14:50:00.000Z",
      },
    ],
    rowCount: 1,
  });
  await expect(listStorePaidOrderBatches(tx, scope, [id(3)])).rejects.toThrow(
    "MERCHANT_ORDER_INDEX_UNAVAILABLE",
  );
  expect(await listStorePaidOrderBatches(tx, scope, [])).toEqual({
    paidOrders: new Set(),
    paidBatches: new Set(),
    awaitingAcceptance: new Set(),
    awaitingSince: new Map(),
  });
  // An awaiting batch without its paid time is not data.
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
    rows: [{ order_id: id(3), order_batch_id: id(13), awaiting: true, since: null }],
    rowCount: 1,
  });
  await expect(listStorePaidOrderBatches(tx, scope, [id(3)])).rejects.toThrow(
    "MERCHANT_ORDER_INDEX_UNAVAILABLE",
  );
});
it("WP-2423 Q2: names many Orders for the kitchen without Customer identity", async () => {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>(
    async (sql) => ({
      rows: sql.startsWith("SELECT set_config")
        ? []
        : [
            { order_id: id(3), order_number: "14", order_type: "DineIn", dining_session: id(40) },
            { order_id: id(4), order_number: "15", order_type: "Pickup", dining_session: null },
          ],
      rowCount: 2,
    }),
  );
  const tx = { query } as unknown as ConsumerTransaction;
  const labels = await listStoreKitchenOrderLabels(tx, scope, [id(3), id(4)]);
  expect(labels.get(id(3))).toEqual({
    orderNumber: "14",
    orderType: "DineIn",
    diningSessionReference: id(40),
  });
  expect(labels.get(id(4))?.diningSessionReference).toBeNull();
  expect(query.mock.calls[1]?.[0]).not.toMatch(/guest|name|contact/iu);
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
    rows: [{ order_id: id(3), order_number: "14", order_type: "DineIn", dining_session: null }],
    rowCount: 1,
  });
  await expect(listStoreKitchenOrderLabels(tx, scope, [id(3)])).rejects.toThrow();
});

it("WP-2423 v15: lists today's Orders with a paid round waiting for acceptance", async () => {
  const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>(
    async (sql) => ({
      rows: sql.startsWith("SELECT set_config")
        ? []
        : [
            { order_id: id(3), order_number: "13", order_type: "Pickup", dining_session: null },
            { order_id: id(4), order_number: "7", order_type: "DineIn", dining_session: id(40) },
          ],
      rowCount: 2,
    }),
  );
  const tx = { query } as unknown as ConsumerTransaction;
  const input = { since: "2026-10-16T08:00:00.000Z", businessDate: "2026-10-16", limit: 50 };
  expect(await listStoreOrdersAwaitingAcceptance(tx, scope, input)).toEqual([
    { orderReference: id(3), orderNumber: "13", orderType: "Pickup", diningSessionReference: null },
    {
      orderReference: id(4),
      orderNumber: "7",
      orderType: "DineIn",
      diningSessionReference: id(40),
    },
  ]);
  const sql = String(query.mock.calls[1]?.[0]);
  // Today's only: the Order's business date, or a later round submitted since the day started.
  expect(sql).toContain("h.business_date=$3::date OR b.submitted_at>=$4::timestamptz");
  expect(sql).toContain("order_payment_disposition_record");
  expect(sql).toContain("order_staff_cancellation");
  expect(sql).not.toMatch(/guest|contact|name/iu);
  expect(query.mock.calls[1]?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    "2026-10-16",
    "2026-10-16T08:00:00.000Z",
    50,
  ]);
  await expect(
    listStoreOrdersAwaitingAcceptance(tx, scope, { ...input, businessDate: "16/10/2026" }),
  ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  await expect(
    listStoreOrdersAwaitingAcceptance(tx, scope, { ...input, limit: 0 }),
  ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 }).mockResolvedValueOnce({
    rows: [{ order_id: id(3), order_number: "13", order_type: "DineIn", dining_session: null }],
    rowCount: 1,
  });
  await expect(listStoreOrdersAwaitingAcceptance(tx, scope, input)).rejects.toThrow(
    "MERCHANT_ORDER_INDEX_UNAVAILABLE",
  );
});

it("WP-2423 D4: reads each round's submission time, whether it is the first and the Order's date", async () => {
  const query = vi.fn(async (sql: string) =>
    sql.startsWith("SELECT b.order_batch_id")
      ? {
          rows: [
            {
              batch_id: id(11),
              order_id: id(3),
              submitted_at: new Date("2026-10-11T23:00:00.000Z"),
              business_date: "2026-10-11",
              initial: true,
            },
            {
              batch_id: id(21),
              order_id: id(3),
              submitted_at: new Date("2026-10-15T18:00:00.000Z"),
              business_date: "2026-10-11",
              initial: false,
            },
          ],
          rowCount: 2,
        }
      : { rows: [], rowCount: 0 },
  );
  const tx = { query } as unknown as ConsumerTransaction;
  const rounds = await listStoreOrderRoundSubmissions(tx, scope, [id(11), id(21)]);
  expect(Object.fromEntries(rounds)).toEqual({
    [id(11)]: {
      orderReference: id(3),
      submittedAt: "2026-10-11T23:00:00.000Z",
      initial: true,
      orderBusinessDate: "2026-10-11",
    },
    [id(21)]: {
      orderReference: id(3),
      submittedAt: "2026-10-15T18:00:00.000Z",
      initial: false,
      orderBusinessDate: "2026-10-11",
    },
  });
  expect((query.mock.calls[1] as unknown[] | undefined)?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    [id(11), id(21)],
  ]);
  await expect(listStoreOrderRoundSubmissions(tx, scope, [])).resolves.toEqual(new Map());
  await expect(
    listStoreOrderRoundSubmissions(
      tx,
      scope,
      Array.from({ length: 101 }, (_, n) => id(n + 1)),
    ),
  ).rejects.toThrow();
});

it("WP-2423 D4: finds Orders opened on an earlier day with a round since today's start", async () => {
  const query = vi.fn(async (sql: string) =>
    sql.startsWith("SELECT h.order_id")
      ? {
          rows: [{ order_id: id(3), latest_round_at: new Date("2026-10-15T18:00:00.000Z") }],
          rowCount: 1,
        }
      : { rows: [], rowCount: 0 },
  );
  const tx = { query } as unknown as ConsumerTransaction;
  await expect(
    listStoreOrdersWithRoundsSince(tx, scope, {
      since: "2026-10-15T08:00:00.000Z",
      businessDate: "2026-10-15",
      limit: 100,
    }),
  ).resolves.toEqual([{ orderReference: id(3), latestRoundAt: "2026-10-15T18:00:00.000Z" }]);
  expect(String(query.mock.calls[1]?.[0])).toContain("h.business_date<$4::date");
  expect((query.mock.calls[1] as unknown[] | undefined)?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    "2026-10-15T08:00:00.000Z",
    "2026-10-15",
    100,
  ]);
  await expect(
    listStoreOrdersWithRoundsSince(tx, scope, {
      since: "2026-10-15T08:00:00.000Z",
      businessDate: "Oct 15",
      limit: 100,
    }),
  ).rejects.toThrow();
});

it("WP-2423 D4: finds each dining session's one Order", async () => {
  const query = vi.fn(async (sql: string) =>
    sql.startsWith("SELECT dining_session_id")
      ? {
          rows: [
            { session_id: id(5), order_id: id(3) },
            // Against the one-Order rule: left out rather than guessed.
            { session_id: id(6), order_id: id(7) },
            { session_id: id(6), order_id: id(8) },
          ],
          rowCount: 3,
        }
      : { rows: [], rowCount: 0 },
  );
  const tx = { query } as unknown as ConsumerTransaction;
  const orders = await listStoreDiningSessionOrders(tx, scope, [id(5), id(6), id(9)]);
  expect(Object.fromEntries(orders)).toEqual({ [id(5)]: id(3) });
});
