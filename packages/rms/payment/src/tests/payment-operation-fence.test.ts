import { expect, it, vi } from "vitest";
import { createPostgresPaymentOperationFence } from "../infrastructure/persistence/payment-intent-creation-store.js";
const id = (n: number) => `0190ee29-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const input = { orderReference: id(3), paymentOperationReference: id(4) };
function fixture(found: unknown = { paymentIntentReference: id(5), orderReference: id(3) }) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    calls.push({ sql, values });
    return {
      rows: sql.includes("FROM rms_payment.payment_intent") ? (found === null ? [] : [found]) : [],
      rowCount: 0,
    };
  });
  const authorize = vi.fn(async (_transaction: unknown, _query: unknown) => {
    void _transaction;
    void _query;
    return true;
  });
  const fence = createPostgresPaymentOperationFence({
    brandReference: id(1),
    storeReference: id(2),
    now: () => "2026-09-21T00:00:00.000Z",
    authorize,
  });
  return { fence, query, calls, authorize };
}
it("locks receipt/order then operation then terminal on the supplied transaction", async () => {
  const f = fixture(),
    tx = { query: f.query };
  expect(await f.fence.acquire(tx, input)).toEqual({ paymentIntentReference: id(5) });
  expect(
    f.calls.filter((c) => c.sql.includes("pg_advisory_xact_lock")).map((c) => c.values[0]),
  ).toEqual([
    `PaymentReceiptOrder:${id(1)}:${id(2)}:${id(3)}`,
    `PaymentIntent:${id(1)}:${id(2)}:${id(4)}`,
    `PaymentTerminal:${id(1)}:${id(2)}:${id(5)}`,
  ]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize.mock.calls[0]?.[0]).toBe(tx);
  expect(f.calls.every((c) => c.sql.startsWith("SELECT"))).toBe(true);
});
it("retains creation fence for missing intent without inventing terminal identity", async () => {
  const f = fixture(null);
  expect(await f.fence.acquire({ query: f.query }, input)).toEqual({
    paymentIntentReference: null,
  });
  expect(f.calls.filter((c) => c.sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
});
it("rejects an operation that belongs to another order", async () => {
  const f = fixture({ paymentIntentReference: id(5), orderReference: id(6) });
  await expect(f.fence.acquire({ query: f.query }, input)).rejects.toMatchObject({
    code: "PAYMENT_INTENT_PERMISSION_DENIED",
  });
  expect(f.calls.filter((c) => c.sql.includes("pg_advisory_xact_lock"))).toHaveLength(2);
});
it("rejects denied authorization before SQL and rechecks after waits", async () => {
  const first = fixture();
  first.authorize.mockResolvedValue(false);
  await expect(first.fence.acquire({ query: first.query }, input)).rejects.toMatchObject({
    code: "PAYMENT_INTENT_PERMISSION_DENIED",
  });
  expect(first.query).not.toHaveBeenCalled();
  const second = fixture();
  second.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(second.fence.acquire({ query: second.query }, input)).rejects.toMatchObject({
    code: "PAYMENT_INTENT_PERMISSION_DENIED",
  });
});
it("rejects malformed identity and extra input before locking", async () => {
  const f = fixture();
  await expect(
    f.fence.acquire({ query: f.query }, { ...input, extra: "private" }),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
