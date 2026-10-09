import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentReconciliationExceptionSource } from "../infrastructure/persistence/payment-reconciliation-exception-source.js";
const id = (n: number) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-21T00:00:00.000Z";
function setup(rows: Record<string, unknown>[] = [row(10), row(11)]) {
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_payment") ? rows : [],
    rowCount: rows.length,
  }));
  const tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  return {
    query,
    tx,
    authorize,
    read: createPostgresPaymentReconciliationExceptionSource({
      scope: { brandReference: id(1), storeReference: id(2) },
      authorize,
    }),
  };
}
function row(n: number) {
  return {
    exception_reference: id(n),
    brand_reference: id(1),
    store_reference: id(2),
    candidate_reference: id(3),
    reason: "AmountMismatch",
    severity: "Error",
    status: "Open",
    opened_at: new Date(at),
  };
}
it("pages safe owner exceptions without inventing Order or payment bindings", async () => {
  const f = setup();
  const page = await f.read(f.tx, { afterExceptionReference: null, limit: 1 });
  expect(page.nextAfterExceptionReference).toBe(id(10));
  expect(page.items[0]).toMatchObject({
    kind: "ReconciliationAmountMismatch",
    orderReference: null,
    paymentIntentReference: null,
    openedAt: at,
    state: "Open",
  });
  expect(page.items[0]).not.toHaveProperty("candidateReference");
  expect(f.query).toHaveBeenLastCalledWith(
    expect.stringContaining("e.brand_id=$1 AND e.store_id=$2"),
    [id(1), id(2), null, 2],
  );
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("finishes empty and exact-limit pages", async () => {
  for (const rows of [[], [row(10)]]) {
    const f = setup(rows);
    expect(
      (await f.read(f.tx, { afterExceptionReference: id(9), limit: 1 }))
        .nextAfterExceptionReference,
    ).toBeNull();
  }
});
it("rejects malformed, wrongscope, wrongseverity, duplicate and oversized rows", async () => {
  for (const rows of [
    [{ ...row(10), store_reference: id(99) }],
    [{ ...row(10), severity: "Critical" }],
    [{ ...row(10), opened_at: "bad" }],
    [row(10), row(10)],
    [row(10), row(11), row(12)],
  ]) {
    const f = setup(rows);
    await expect(f.read(f.tx, { afterExceptionReference: id(9), limit: 1 })).rejects.toThrow();
  }
});
it("denies revoked authorization and invalid bounds", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.read(f.tx, { afterExceptionReference: null, limit: 1 })).rejects.toMatchObject({
    code: "PAYMENT_COMPENSATION_PERMISSION_DENIED",
  });
  const denied = setup();
  denied.authorize.mockResolvedValue(false);
  await expect(
    denied.read(denied.tx, { afterExceptionReference: null, limit: 1 }),
  ).rejects.toThrow();
  expect(denied.query).not.toHaveBeenCalled();
  for (const limit of [0, 101, 1.5]) {
    await expect(
      denied.read(denied.tx, { afterExceptionReference: null, limit }),
    ).rejects.toThrow();
  }
  expect(denied.query).not.toHaveBeenCalled();
});
it("redacts dependency failures", async () => {
  const f = setup();
  f.query.mockRejectedValue(Error("private database detail"));
  await expect(f.read(f.tx, { afterExceptionReference: null, limit: 1 })).rejects.toMatchObject({
    code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
    message: "payment compensation is unavailable",
  });
});

function linkedSetup(records: Record<string, unknown>[]) {
  const resolveIntent = vi.fn(async (_tx: ConsumerTransaction, intent: string) => ({
    paymentIntentReference: intent,
    paymentAttemptReference: id(21),
    orderReference: id(22),
  }));
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_payment.payment_reconciliation_record")
      ? records
      : sql.includes("FROM rms_payment.payment_reconciliation_exception")
        ? [row(10)]
        : [],
    rowCount: 0,
  }));
  const tx = { query } as unknown as ConsumerTransaction;
  const read = createPostgresPaymentReconciliationExceptionSource({
    scope: { brandReference: id(1), storeReference: id(2) },
    authorize: async () => true,
    resolveIntent,
  });
  return { tx, query, resolveIntent, read };
}
const record = {
  mode: "Operational",
  intent: id(20),
  difference_reason: "AmountMismatch",
  outcome: "Difference",
};
it("enriches a uniquely bound operational exception through the same-transaction owner resolver", async () => {
  const f = linkedSetup([record]);
  const result = await f.read(f.tx, { afterExceptionReference: null, limit: 5 });
  expect(result.items[0]).toMatchObject({
    paymentIntentReference: id(20),
    paymentAttemptReference: id(21),
    orderReference: id(22),
  });
  expect(f.resolveIntent).toHaveBeenCalledWith(f.tx, id(20));
  expect(f.query).toHaveBeenCalledWith(
    expect.stringContaining("reconciliation_exception_id=$3 LIMIT 2"),
    [id(1), id(2), id(10)],
  );
});
it("preserves unresolved exceptions for missing or daily settlement records", async () => {
  for (const records of [[], [{ ...record, mode: "DailySettlement", intent: null }]]) {
    const f = linkedSetup(records);
    const result = await f.read(f.tx, { afterExceptionReference: null, limit: 5 });
    expect(result.items[0]?.orderReference).toBeNull();
    expect(f.resolveIntent).not.toHaveBeenCalled();
  }
});
it("refuses conflicting records and mismatched record or resolver identity", async () => {
  for (const records of [
    [record, { ...record, intent: id(99) }],
    [{ ...record, difference_reason: "StateMismatch" }],
    [{ ...record, outcome: "Matched" }],
    [{ ...record, mode: "DailySettlement" }],
    [{ ...record, intent: null }],
  ]) {
    const f = linkedSetup(records);
    await expect(f.read(f.tx, { afterExceptionReference: null, limit: 5 })).rejects.toThrow();
  }
  const f = linkedSetup([record]);
  f.resolveIntent.mockResolvedValue({
    paymentIntentReference: id(99),
    paymentAttemptReference: id(21),
    orderReference: id(22),
  });
  await expect(f.read(f.tx, { afterExceptionReference: null, limit: 5 })).rejects.toThrow();
});
