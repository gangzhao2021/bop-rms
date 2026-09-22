import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresPaymentReconciliationRunSource,
  createPostgresPaymentReconciliationRepository,
} from "../infrastructure/persistence/payment-reconciliation-run-source.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-22T00:00:00.000Z";
function setup() {
  const run: Record<string, unknown> = {
    reconciliation_run_id: id(1),
    brand_id: id(2),
    store_id: id(3),
    mode: "Operational",
    actor_id: null,
    purpose: "ReconcilePayments",
    scheduled_at: new Date(at),
    cutoff_at: new Date(at),
    max_candidates: 10,
    completed_at: new Date(at),
    matched_count: 0,
    healed_count: 0,
    unresolved_count: 0,
    unavailable_count: 0,
    difference_count: 1,
  };
  const check: Record<string, unknown> = {
    reconciliation_check_id: id(4),
    reconciliation_run_id: id(1),
    candidate_id: id(5),
    brand_id: id(2),
    store_id: id(3),
    mode: "Operational",
    payment_intent_id: id(6),
    settlement_reference: null,
    outcome: "Difference",
    difference_reason: "RefundMismatch",
    internal_status: "Captured",
    provider_status: "Captured",
    internal_captured_minor: "1130",
    provider_captured_minor: "1130",
    internal_refunded_minor: "0",
    provider_refunded_minor: "1130",
    currency_code: "CAD",
    reconciliation_exception_id: id(7),
    safe_code: null,
    checked_at: new Date(at),
  };
  const exception: Record<string, unknown> = {
    reconciliation_exception_id: id(7),
    brand_id: id(2),
    store_id: id(3),
    candidate_id: id(5),
    reason: "RefundMismatch",
    severity: "Error",
    status: "Open",
    opened_at: new Date("2026-09-21T00:00:00.000Z"),
  };
  const rows = { runs: [run], checks: [check], exceptions: [exception] };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("SELECT e.*")
      ? rows.exceptions
      : sql.includes("FROM rms_payment.payment_reconciliation_record")
        ? rows.checks
        : sql.includes("FROM rms_payment.payment_reconciliation_run")
          ? rows.runs
          : [],
    rowCount: 0,
  }));
  const tx = { query } as unknown as ConsumerTransaction;
  const authorize = vi.fn(async () => true);
  return {
    rows,
    query,
    tx,
    authorize,
    read: createPostgresPaymentReconciliationRunSource({
      scope: { brandReference: id(2), storeReference: id(3) },
      authorize,
    }),
  };
}
it("reads the complete scoped run and preserves older stable exceptions", async () => {
  const f = setup();
  const r = await f.read(f.tx, { runReference: id(1) });
  expect(r?.checks[0]?.providerRefundedAmount?.amountMinor).toBe(1130n);
  expect(r?.exceptions[0]?.openedAt).toBe("2026-09-21T00:00:00.000Z");
  expect(r?.counts.Difference).toBe(1);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  for (const [sql, params] of f.query.mock.calls as unknown as [string, unknown[]][])
    if (sql.includes("FROM rms_payment")) {
      expect(sql).toContain("brand_id=$1");
      expect(sql).toContain("store_id=$2");
      expect(params).toEqual([id(2), id(3), id(1)]);
    }
});
it("returns null only for a missing run after renewed authorization", async () => {
  const f = setup();
  f.rows.runs = [];
  expect(await f.read(f.tx, { runReference: id(1) })).toBeNull();
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it.each([
  "missing-check",
  "missing-exception",
  "duplicate-check",
  "scope",
  "wrong-run",
  "counts",
  "numeric-money",
  "malformed-money",
  "overflow-money",
  "currency",
  "future-exception",
  "oversized",
])("rejects incomplete or corrupt persisted evidence: %s", async (kind) => {
  const f = setup();
  const r = f.rows.runs[0],
    c = f.rows.checks[0],
    e = f.rows.exceptions[0];
  if (!r || !c || !e) throw Error("fixture");
  if (kind === "missing-check") f.rows.checks = [];
  if (kind === "missing-exception") f.rows.exceptions = [];
  if (kind === "duplicate-check") f.rows.checks.push({ ...c });
  if (kind === "scope") c.store_id = id(9);
  if (kind === "wrong-run") r.reconciliation_run_id = id(9);
  if (kind === "counts") r.difference_count = 0;
  if (kind === "numeric-money") c.internal_captured_minor = 1130;
  if (kind === "malformed-money") c.internal_captured_minor = "01";
  if (kind === "overflow-money") c.internal_captured_minor = "9223372036854775808";
  if (kind === "currency") c.currency_code = "USD";
  if (kind === "future-exception") e.opened_at = "2026-09-23T00:00:00.000Z";
  if (kind === "oversized") f.rows.checks = Array.from({ length: 101 }, () => ({ ...c }));
  await expect(f.read(f.tx, { runReference: id(1) })).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("denies before SQL and rechecks revocation after reading", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.read(f.tx, { runReference: id(1) })).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
  expect(f.query).not.toHaveBeenCalled();
  const g = setup();
  g.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(g.read(g.tx, { runReference: id(1) })).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
});
it("redacts underlying database failures", async () => {
  const f = setup();
  f.query.mockRejectedValue(Error("private-sql-canary"));
  await expect(f.read(f.tx, { runReference: id(1) })).rejects.toThrow(
    "payment reconciliation is unavailable",
  );
});

async function repositoryFixture() {
  const f = setup();
  const expected = await f.read(f.tx, { runReference: id(1) });
  if (!expected) throw Error("fixture");
  const original = {
    runs: [...f.rows.runs],
    checks: [...f.rows.checks],
    exceptions: [...f.rows.exceptions],
  };
  let rolledBack = false,
    committed = false;
  const repository = createPostgresPaymentReconciliationRepository({
    scope: { brandReference: id(2), storeReference: id(3) },
    authorize: f.authorize,
    transactions: {
      run: async (work) => {
        try {
          const result = await work(f.tx);
          committed = true;
          return result;
        } catch (e) {
          rolledBack = true;
          throw e;
        }
      },
    },
  });
  const select = f.query.getMockImplementation();
  if (!select) throw Error("fixture");
  const append = (sql: string) => {
    if (sql.includes("INSERT INTO rms_payment.payment_reconciliation_run"))
      f.rows.runs = original.runs;
    if (sql.includes("INSERT INTO rms_payment.payment_reconciliation_record"))
      f.rows.checks = original.checks;
    if (sql.includes("INSERT INTO rms_payment.payment_reconciliation_exception"))
      f.rows.exceptions = original.exceptions;
  };
  f.query.mockClear();
  f.authorize.mockClear();
  return {
    ...f,
    expected,
    repository,
    original,
    select,
    append,
    transactionState: () => ({ rolledBack, committed }),
  };
}
it("returns duplicate/conflict without appending an existing immutable run", async () => {
  const f = await repositoryFixture();
  expect((await f.repository.commit(f.expected)).status).toBe("Duplicate");
  expect(
    (await f.repository.commit({ ...f.expected, run: { ...f.expected.run, maxCandidates: 9 } }))
      .status,
  ).toBe("Conflict");
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
it("appends the complete unit and accepts its preserved first exception opening", async () => {
  const f = await repositoryFixture();
  f.rows.runs = [];
  f.rows.checks = [];
  f.rows.exceptions = [];
  f.query.mockImplementation(async (sql) => {
    f.append(sql);
    return f.select(sql);
  });
  const proposed = {
    ...f.expected,
    exceptions: f.expected.exceptions.map((e) => ({ ...e, openedAt: at })),
  };
  const result = await f.repository.commit(proposed);
  expect(result.status).toBe("Created");
  expect(result.result.exceptions[0]?.openedAt).toBe("2026-09-21T00:00:00.000Z");
  expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(3);
  expect(f.transactionState()).toEqual({ rolledBack: false, committed: true });
});
it.each(["insert-failure", "incomplete-readback", "revoked"])(
  "propagates %s to transaction rollback",
  async (kind) => {
    const f = await repositoryFixture();
    f.rows.runs = [];
    f.rows.checks = [];
    f.rows.exceptions = [];
    f.query.mockImplementation(async (sql) => {
      if (sql.includes("INSERT INTO rms_payment.payment_reconciliation_record")) {
        if (kind === "insert-failure") throw Error("database-failure");
        if (kind === "revoked") f.authorize.mockResolvedValue(false);
        if (kind === "incomplete-readback") return { rows: [], rowCount: 0 };
      }
      f.append(sql);
      return f.select(sql);
    });
    await expect(f.repository.commit(f.expected)).rejects.toThrow();
    expect(f.transactionState()).toEqual({ rolledBack: true, committed: false });
  },
);
it("rejects a different Store before SQL or appends", async () => {
  const f = await repositoryFixture();
  const other = id(9);
  await expect(
    f.repository.commit({
      ...f.expected,
      run: { ...f.expected.run, storeReference: other },
      checks: f.expected.checks.map((c) => ({ ...c, storeReference: other })),
      exceptions: f.expected.exceptions.map((e) => ({ ...e, storeReference: other })),
    }),
  ).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_RUN_CONFLICT" });
  expect(f.query).not.toHaveBeenCalled();
});
