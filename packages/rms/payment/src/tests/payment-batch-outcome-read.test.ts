import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  listStoreOrderBatchPaymentOutcomes,
  listStoreOrderOnlinePaidTotals,
  listStoreOrdersWithOnlineRefunds,
  readStoreOrderOnlinePaidTip,
} from "../infrastructure/persistence/payment-status-store.js";

const id = (n: number) => "0198a106-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
function fixture(rows: unknown[]) {
  const query = vi.fn().mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM rms_payment") ? rows : [],
    rowCount: 1,
  }));
  return { query, transaction: { query } as unknown as ConsumerTransaction };
}
const row = (batch: number, terminal_status = "Failed", order = 50) => ({
  order_id: id(order),
  order_batch_id: id(batch),
  terminal_status,
});

it("WP-2423: reads the latest active terminal outcome per batch of the scoped Orders", async () => {
  const f = fixture([row(60, "Succeeded"), row(61)]);
  const found = await listStoreOrderBatchPaymentOutcomes(f.transaction, scope, [id(50)]);
  expect(found).toEqual([
    { orderReference: id(50), orderBatchReference: id(60), status: "Succeeded" },
    { orderReference: id(50), orderBatchReference: id(61), status: "Failed" },
  ]);
  expect(Object.isFrozen(found)).toBe(true);
  expect(f.query.mock.calls[0]?.[1]).toEqual([id(1), id(2)]);
  const sql = String(f.query.mock.calls[1]?.[0]);
  expect(sql).toContain("DISTINCT ON (i.order_batch_id)");
  expect(sql).toContain("p.is_active");
  expect(sql).toContain("i.brand_id=$1 AND i.store_id=$2");
  expect(sql).toContain("p.terminal_occurred_at DESC");
  expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), [id(50)]]);
  expect(await listStoreOrderBatchPaymentOutcomes(f.transaction, scope, [])).toEqual([]);
});

it("WP-2423: refuses foreign, duplicate or malformed rows and oversized requests", async () => {
  for (const rows of [
    [row(60, "Failed", 99)],
    [row(60), row(60)],
    [row(60, "Pending")],
    [{ ...row(60), amount_minor: "1" }],
    [{ ...row(60), order_batch_id: "batch" }],
  ])
    await expect(
      listStoreOrderBatchPaymentOutcomes(fixture(rows).transaction, scope, [id(50)]),
    ).rejects.toMatchObject({ code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" });
  await expect(
    listStoreOrderBatchPaymentOutcomes(
      fixture([]).transaction,
      scope,
      Array.from({ length: 101 }, (_, n) => id(1000 + n)),
    ),
  ).rejects.toThrow();
});

it("WP-2423: sums each Order's active succeeded online payments for the Orders page", async () => {
  const paid = (order: number, amount_minor: string) => ({
    order_id: id(order),
    amount_minor,
    currency_code: "CAD",
    currencies: 1,
  });
  const f = fixture([paid(50, "1130"), paid(51, "2260")]);
  const found = await listStoreOrderOnlinePaidTotals(f.transaction, scope, [id(50), id(51)]);
  expect(found).toEqual([
    { orderReference: id(50), amountMinor: "1130", currencyCode: "CAD" },
    { orderReference: id(51), amountMinor: "2260", currencyCode: "CAD" },
  ]);
  expect(Object.isFrozen(found)).toBe(true);
  expect(f.query.mock.calls[0]?.[1]).toEqual([id(1), id(2)]);
  const sql = String(f.query.mock.calls[1]?.[0]);
  expect(sql).toContain("p.is_active");
  expect(sql).toContain("p.terminal_status='Succeeded'");
  expect(sql).toContain("i.brand_id=$1 AND i.store_id=$2");
  expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), [id(50), id(51)]]);
  expect(await listStoreOrderOnlinePaidTotals(f.transaction, scope, [])).toEqual([]);
  for (const rows of [
    [paid(99, "1130")],
    [paid(50, "1130"), paid(50, "1")],
    [paid(50, "0")],
    [paid(50, "11.30")],
    [{ ...paid(50, "1130"), currencies: 2 }],
    [{ ...paid(50, "1130"), currency_code: "USD" }],
    [{ ...paid(50, "1130"), extra: 1 }],
  ])
    await expect(
      listStoreOrderOnlinePaidTotals(fixture(rows).transaction, scope, [id(50)]),
    ).rejects.toMatchObject({ code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" });
  await expect(
    listStoreOrderOnlinePaidTotals(
      fixture([]).transaction,
      scope,
      Array.from({ length: 101 }, (_, n) => id(1000 + n)),
    ),
  ).rejects.toThrow();
});

it("WP-2423 (3cd0f8dd M1): reads the tip of an Order's succeeded online payments", async () => {
  const f = fixture([{ tip_minor: "176" }]);
  expect(await readStoreOrderOnlinePaidTip(f.transaction, scope, id(50))).toBe(176n);
  expect(f.query.mock.calls[0]?.[1]).toEqual([id(1), id(2)]);
  const sql = String(f.query.mock.calls[1]?.[0]);
  expect(sql).toContain("sum(i.tip_minor)");
  expect(sql).toContain("p.is_active AND p.terminal_status='Succeeded'");
  expect(sql).toContain("i.brand_id=$1 AND i.store_id=$2 AND i.order_id=$3");
  expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(50)]);
  expect(
    await readStoreOrderOnlinePaidTip(fixture([{ tip_minor: "0" }]).transaction, scope, id(50)),
  ).toBe(0n);
  for (const rows of [
    [],
    [{ tip_minor: "1.76" }],
    [{ tip_minor: "-1" }],
    [{ tip_minor: 176 }],
    [{ tip_minor: "1", extra: 1 }],
    [{ tip_minor: "1" }, { tip_minor: "2" }],
  ])
    await expect(
      readStoreOrderOnlinePaidTip(fixture(rows).transaction, scope, id(50)),
    ).rejects.toMatchObject({ code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" });
});

it("WP-2423: lists the scoped Orders with an ordinary or compensation refund", async () => {
  const f = fixture([{ order_id: id(50) }, { order_id: id(52) }]);
  const found = await listStoreOrdersWithOnlineRefunds(f.transaction, scope, [
    id(50),
    id(51),
    id(52),
  ]);
  expect([...found]).toEqual([id(50), id(52)]);
  expect(f.query.mock.calls[0]?.[1]).toEqual([id(1), id(2)]);
  const sql = String(f.query.mock.calls[1]?.[0]);
  expect(sql).toContain("rms_payment.ordinary_refund_request");
  expect(sql).toContain("rms_payment.payment_compensation_refund");
  expect(sql).toContain("r.brand_id=$1 AND r.store_id=$2");
  expect(sql).toContain("c.brand_id=$1 AND c.store_id=$2");
  expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), [id(50), id(51), id(52)]]);
  const none = fixture([]);
  expect([...(await listStoreOrdersWithOnlineRefunds(none.transaction, scope, []))]).toEqual([]);
  expect(none.query).not.toHaveBeenCalled();
  for (const rows of [
    [{ order_id: id(99) }],
    [{ order_id: id(50) }, { order_id: id(50) }],
    [{ order_id: "order" }],
    [{ order_id: id(50), extra: 1 }],
  ])
    await expect(
      listStoreOrdersWithOnlineRefunds(fixture(rows).transaction, scope, [id(50)]),
    ).rejects.toMatchObject({ code: "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE" });
  await expect(
    listStoreOrdersWithOnlineRefunds(
      fixture([]).transaction,
      scope,
      Array.from({ length: 101 }, (_, n) => id(1000 + n)),
    ),
  ).rejects.toThrow();
});
