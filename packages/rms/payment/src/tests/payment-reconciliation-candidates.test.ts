import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentReconciliationCandidates } from "../infrastructure/persistence/payment-reconciliation-candidates.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const cutoffAt = "2026-09-22T00:15:00.000Z";
function fixture() {
  const rows: Record<string, unknown>[] = [
    {
      brand: id(1),
      store: id(2),
      intent: id(3),
      operation: id(4),
      order_reference: id(5),
      attempt: id(6),
      environment: "Test",
      created_at: new Date("2026-09-22T00:00:00.000Z"),
      due_at: new Date(cutoffAt),
    },
  ];
  const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM rms_payment") ? rows : [],
      rowCount: 0,
    })),
    tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  return {
    rows,
    query,
    tx,
    authorize,
    read: createPostgresPaymentReconciliationCandidates({
      scope: { brandReference: id(1), storeReference: id(2), environment: "Test" },
      authorize,
    }),
  };
}
it("returns only scoped routing identities in due order with bounded SQL", async () => {
  const f = fixture();
  const items = await f.read(f.tx, { cutoffAt, limit: 10 });
  expect(items).toEqual([
    {
      paymentIntentReference: id(3),
      paymentOperationReference: id(4),
      paymentAttemptReference: id(6),
      orderReference: id(5),
      createdAt: "2026-09-22T00:00:00.000Z",
      dueAt: cutoffAt,
    },
  ]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.query).toHaveBeenLastCalledWith(
    expect.stringContaining("ORDER BY d.due_at,i.payment_intent_id LIMIT $5"),
    [id(1), id(2), "Test", cutoffAt, 10],
  );
  const sql = String(f.query.mock.calls[1]?.[0]);
  expect(sql).toContain("interval '13 minutes'");
  // WP-2423: matched payments daily, unresolved ones daily after their first day, nothing routine
  // after 30 days, and any new payment fact brings a payment back immediately.
  expect(sql).toContain("WHEN c.outcome = 'Matched' THEN c.checked_at + interval '1 day'");
  expect(sql).toContain("interval '30 days' THEN NULL");
  expect(sql).toContain("WHEN n.fact_at > c.checked_at THEN n.fact_at");
  expect(sql).toContain("d.due_at IS NOT NULL AND d.due_at<=$4");
});
it.each([
  "scope",
  "environment",
  "future",
  "before-created",
  "duplicate",
  "order",
  "oversize",
  "reference",
])("refuses corrupt routing page %s", async (kind) => {
  const f = fixture(),
    row = f.rows[0];
  if (!row) throw Error("fixture");
  if (kind === "scope") row.store = id(9);
  if (kind === "environment") row.environment = "Live";
  if (kind === "future") row.due_at = "2026-09-22T00:16:00.000Z";
  if (kind === "before-created") row.due_at = "2026-09-21T00:00:00.000Z";
  if (kind === "duplicate") f.rows.push({ ...row });
  if (kind === "order") f.rows.push({ ...row, intent: id(2) });
  if (kind === "oversize") f.rows.push({ ...row, intent: id(9) });
  if (kind === "reference") row.operation = "bad";
  await expect(
    f.read(f.tx, { cutoffAt, limit: kind === "oversize" ? 1 : 10 }),
  ).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE" });
});
it("accepts empty pages and rejects invalid limits before SQL", async () => {
  const f = fixture();
  f.rows.length = 0;
  expect(await f.read(f.tx, { cutoffAt, limit: 1 })).toEqual([]);
  f.query.mockClear();
  await expect(f.read(f.tx, { cutoffAt, limit: 101 })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
it("checks authorization before SQL and after discovery", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.read(f.tx, { cutoffAt, limit: 1 })).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
  expect(f.query).not.toHaveBeenCalled();
  const g = fixture();
  g.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(g.read(g.tx, { cutoffAt, limit: 1 })).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
});
