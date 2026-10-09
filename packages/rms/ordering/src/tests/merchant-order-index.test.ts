import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresMerchantOrderIndex } from "../infrastructure/persistence/merchant-order-index.js";
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
    "submittedAt",
    "initialSubmissionReference",
    "initialBatchReference",
  ]);
  expect(query.mock.calls[1]?.[0]).toContain("h.brand_id=$1 AND h.store_id=$2");
});
it.each([{ rows: [row(3), row(3)] }, { rows: [{ ...row(3), store_id: id(8) }] }])(
  "rejects duplicate or foreign source rows",
  async ({ rows }) => {
    const { tx } = fixture(rows);
    await expect(
      createPostgresMerchantOrderIndex({ ...scope, authorize: async () => true }).list({
        transaction: tx,
        limit: 10,
        afterOrderReference: null,
      }),
    ).rejects.toThrow("MERCHANT_ORDER_INDEX_UNAVAILABLE");
  },
);
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
  ]);
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
