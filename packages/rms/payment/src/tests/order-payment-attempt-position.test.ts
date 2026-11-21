import { expect, it, vi } from "vitest";
import { createPostgresOrderPaymentAttemptPosition } from "../infrastructure/persistence/order-payment-attempt-position.js";
const id = (n: number) => "0190fae4-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
const scope = {
  brandReference: id(1),
  storeReference: id(2),
  providerAccountReference: id(3),
  environment: "Test" as const,
};
const row = (n = 10) => ({
  payment_intent_id: id(n),
  order_batch_id: id(n + 1),
  total_minor: "1130",
  order_allocation_minor: "1030",
  tip_minor: "100",
  currency_code: "CAD",
  created_at: new Date(at),
  payment_attempt_id: id(n + 2),
  provider_environment: "Test",
  attempt_created_at: new Date(at),
  payment_transaction_id: id(n + 3),
  terminal_outcome: "Succeeded",
  amount_minor: "1130",
  terminal_currency: "CAD",
  recorded_at: new Date(at),
  provider_account_id: id(3),
  terminal_environment: "Test",
  terminal_bound: true,
});
function setup(rows: Record<string, unknown>[]) {
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    expect(values).toBeDefined();
    if (sql.startsWith("SELECT payment_intent_id::text"))
      return { rows: rows.map((row) => ({ payment_intent_id: row.payment_intent_id })) };
    if (sql.startsWith("SELECT i.payment_intent_id::text")) return { rows };
    return { rows: [] };
  });
  const authorize = vi.fn(async () => true),
    reader = createPostgresOrderPaymentAttemptPosition({ scope, authorize });
  return {
    query,
    authorize,
    load: () =>
      reader.load(
        {
          async query<Row>(sql: string, values: readonly unknown[]) {
            const result = await query(sql, values);
            return { rows: result.rows as readonly Row[], rowCount: result.rows.length };
          },
        },
        { orderReference: id(4), observedAt: at },
      ),
  };
}
it("includes unresolved attempts alongside successful capture and retains missing-row fences", async () => {
  const pending = {
    ...row(20),
    payment_transaction_id: null,
    terminal_outcome: null,
    recorded_at: null,
    amount_minor: null,
    terminal_currency: null,
    provider_account_id: null,
    terminal_environment: null,
    terminal_bound: null,
  };
  const f = setup([row(), pending]),
    result = await f.load();
  expect(result.capturedMinor).toBe(1130n);
  expect(result.attempts[0]).toMatchObject({ orderAllocationMinor: "1030", tipMinor: "100" });
  expect(result.unresolvedCount).toBe(1);
  expect(result.attempts).toHaveLength(2);
  expect(Object.isFrozen(result.attempts[0])).toBe(true);
  expect(f.query.mock.calls[1]?.[1]).toEqual([
    "PaymentReceiptOrder:" + id(1) + ":" + id(2) + ":" + id(4),
  ]);
  expect(f.query.mock.calls[3]?.[1]).toEqual([
    "PaymentTerminal:" + id(1) + ":" + id(2) + ":" + id(10),
  ]);
  expect(f.query.mock.calls[2]?.[1]).toEqual([id(1), id(2), id(4)]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("preserves definitive failed attempts without counting capture", async () => {
  const f = setup([
      { ...row(), terminal_outcome: "Failed", amount_minor: null, terminal_currency: null },
    ]),
    result = await f.load();
  expect(result.failedCount).toBe(1);
  expect(result.unresolvedCount).toBe(0);
  expect(result.capturedMinor).toBe(0n);
});
it("returns an empty inventory, never a settled financial class", async () => {
  const result = await setup([]).load();
  expect(result.attempts).toEqual([]);
  expect(result).not.toHaveProperty("financialClass");
});
it.each([
  { payment_attempt_id: null },
  { terminal_bound: false },
  { provider_account_id: id(99) },
  { provider_environment: "Live" },
  { amount_minor: "1129" },
  { total_minor: "1.5" },
  { order_allocation_minor: "1130" },
  { tip_minor: "-1" },
  { recorded_at: new Date("2026-09-21T00:00:00.000Z") },
])("rejects inconsistent persisted facts %j", async (change) => {
  await expect(setup([{ ...row(), ...change }]).load()).rejects.toThrow(
    "ORDER_PAYMENT_ATTEMPT_POSITION_UNAVAILABLE",
  );
});
it("rejects duplicate and oversized inventories", async () => {
  await expect(setup([row(), row()]).load()).rejects.toThrow();
  await expect(setup(Array.from({ length: 1001 }, () => row())).load()).rejects.toThrow();
});
it("denies before reading and after current permission revocation", async () => {
  const denied = setup([]);
  denied.authorize.mockResolvedValue(false);
  await expect(denied.load()).rejects.toThrow();
  expect(denied.query).not.toHaveBeenCalled();
  const revoked = setup([row()]);
  revoked.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(revoked.load()).rejects.toThrow();
});
