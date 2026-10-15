import type { ConsumerTransaction } from "@bop/eventing";
import { expect, it, vi } from "vitest";
import {
  diningCheckoutPaymentWindowMinutes,
  listStoreDiningBatchPaymentDeadlines,
  listStoreUnpaidBatchCancellations,
  loadDiningBatchPaymentWindowStart,
} from "../infrastructure/persistence/order-batch-checkout-expiry-store.js";

const id = (n: number) => `0190ee31-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { brandReference: id(1), storeReference: id(2) };
function fixture(rows: unknown[]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_ordering") ? rows : [],
    rowCount: rows.length,
  }));
  return { query, tx: { query: query as typeof query & ConsumerTransaction["query"] } };
}

it("WP-2423: reads each Dining-owned round's payment deadline from the one shared window", async () => {
  expect(diningCheckoutPaymentWindowMinutes).toBe(30);
  const f = fixture([
    {
      orderReference: id(10),
      orderBatchReference: id(20),
      paymentDeadline: "2026-10-11T23:06:00.000Z",
    },
  ]);
  expect(await listStoreDiningBatchPaymentDeadlines(f.tx, scope, [id(10)])).toEqual([
    {
      orderReference: id(10),
      orderBatchReference: id(20),
      paymentDeadline: "2026-10-11T23:06:00.000Z",
    },
  ]);
  expect(f.query.mock.calls[0]?.[0]).toContain("set_config('bop.brand_id'");
  const sql = String(f.query.mock.calls[1]?.[0]);
  expect(sql).toContain("interval '30 minutes'");
  expect(sql).toContain("link_json->>'owner'='Dining'");
  expect(sql).toContain("l.brand_id=$1 AND l.store_id=$2");
  expect(await listStoreDiningBatchPaymentDeadlines(f.tx, scope, [])).toEqual([]);
});

it("WP-2423: reads unpaid round cancellations of the scoped Orders", async () => {
  const f = fixture([
    {
      orderReference: id(10),
      orderBatchReference: id(20),
      cancelledAt: new Date("2026-10-11T23:07:00.000Z"),
    },
  ]);
  expect(await listStoreUnpaidBatchCancellations(f.tx, scope, [id(10)])).toEqual([
    {
      orderReference: id(10),
      orderBatchReference: id(20),
      cancelledAt: "2026-10-11T23:07:00.000Z",
    },
  ]);
  expect(String(f.query.mock.calls[1]?.[0])).toContain(
    "FROM rms_ordering.order_batch_checkout_cancellation",
  );
});

it("WP-2423: refuses foreign, duplicate or malformed rows and oversized requests", async () => {
  const deadline = {
    orderReference: id(10),
    orderBatchReference: id(20),
    paymentDeadline: "2026-10-11T23:06:00.000Z",
  };
  for (const rows of [
    [{ ...deadline, orderReference: id(99) }],
    [deadline, deadline],
    [{ ...deadline, paymentDeadline: "soon" }],
    [{ ...deadline, extra: 1 }],
  ])
    await expect(
      listStoreDiningBatchPaymentDeadlines(fixture(rows).tx, scope, [id(10)]),
    ).rejects.toThrow();
  const cancelled = {
    orderReference: id(10),
    orderBatchReference: id(20),
    cancelledAt: "2026-10-11T23:07:00.000Z",
  };
  for (const rows of [[{ ...cancelled, orderReference: id(99) }], [cancelled, cancelled]])
    await expect(
      listStoreUnpaidBatchCancellations(fixture(rows).tx, scope, [id(10)]),
    ).rejects.toThrow();
  const many = Array.from({ length: 101 }, (_, n) => id(1000 + n));
  await expect(listStoreDiningBatchPaymentDeadlines(fixture([]).tx, scope, many)).rejects.toThrow();
  await expect(listStoreUnpaidBatchCancellations(fixture([]).tx, scope, many)).rejects.toThrow();
});

it("WP-2423 item 3: reads when a never-requested round's payment window started", async () => {
  const round = {
    orderReference: id(10),
    orderBatchReference: id(20),
    submissionReference: id(30),
    commitmentReference: id(40),
    paymentOperationReference: id(50),
  };
  const f = fixture([{ windowStartsAt: "2026-09-20T07:36:57.527Z" }]);
  expect(await loadDiningBatchPaymentWindowStart(f.tx, scope, round)).toBe(
    "2026-09-20T07:36:57.527Z",
  );
  expect(f.query.mock.calls[0]?.[0]).toContain("set_config('bop.brand_id'");
  const sql = String(f.query.mock.calls[1]?.[0]);
  expect(sql).toContain("GREATEST(b.submitted_at,l.created_at)");
  expect(sql).toContain("link_json->>'owner'='Dining'");
  expect((f.query.mock.calls[1] as unknown[] | undefined)?.[1]).toEqual([
    scope.brandReference,
    scope.storeReference,
    id(10),
    id(20),
    id(30),
    id(40),
    id(50),
  ]);
  expect(await loadDiningBatchPaymentWindowStart(fixture([]).tx, scope, round)).toBeNull();
  for (const rows of [
    [
      { windowStartsAt: "2026-09-20T07:36:57.527Z" },
      { windowStartsAt: "2026-09-20T07:36:57.527Z" },
    ],
    [{ windowStartsAt: "soon" }],
    [{ windowStartsAt: "2026-09-20T07:36:57.527Z", extra: 1 }],
  ])
    await expect(
      loadDiningBatchPaymentWindowStart(fixture(rows).tx, scope, round),
    ).rejects.toThrow();
  await expect(
    loadDiningBatchPaymentWindowStart(fixture([]).tx, scope, { ...round, extra: 1 }),
  ).rejects.toThrow();
  await expect(
    loadDiningBatchPaymentWindowStart(fixture([]).tx, scope, { ...round, orderReference: "x" }),
  ).rejects.toThrow();
});
