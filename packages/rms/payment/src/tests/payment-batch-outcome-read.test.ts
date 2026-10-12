import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { listStoreOrderBatchPaymentOutcomes } from "../infrastructure/persistence/payment-status-store.js";

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
