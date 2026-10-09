import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentReconciliationWindowSource } from "../infrastructure/persistence/payment-reconciliation-window-source.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const startsAt = "2026-09-21T08:00:00.000Z",
  endsAt = "2026-09-22T08:00:00.000Z";
function setup() {
  const run: Record<string, unknown> = {
    run_reference: id(1),
    mode: "DailySettlement",
    scheduled_at: new Date("2026-09-22T08:05:00.000Z"),
    cutoff_at: new Date(endsAt),
    completed_at: new Date("2026-09-22T08:06:00.000Z"),
    matched_count: 12,
    healed_count: 1,
    unresolved_count: 0,
    unavailable_count: 0,
    difference_count: 1,
  };
  const check: Record<string, unknown> = {
    check_reference: id(4),
    run_reference: id(1),
    checked_at: new Date("2026-09-22T08:05:30.000Z"),
    outcome: "Difference",
    difference_reason: "RefundMismatch",
    settlement_reference: "SETTLE-2026-09-21",
    internal_status: "Captured",
    provider_status: "Captured",
    currency_code: "CAD",
    internal_captured_minor: "1130",
    provider_captured_minor: "1130",
    internal_refunded_minor: "0",
    provider_refunded_minor: "1130",
    exception_reference: id(7),
  };
  const rows = { runs: [run], checks: [check] };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_payment.payment_reconciliation_record")
      ? rows.checks
      : sql.includes("FROM rms_payment.payment_reconciliation_run")
        ? rows.runs
        : [],
    rowCount: 0,
  }));
  const tx = { query } as unknown as ConsumerTransaction;
  const authorize = vi.fn<(tx: ConsumerTransaction, input: unknown) => Promise<boolean>>(
    async () => true,
  );
  return {
    rows,
    query,
    tx,
    authorize,
    read: createPostgresPaymentReconciliationWindowSource({
      scope: { brandReference: id(2), storeReference: id(3) },
      authorize,
    }),
  };
}
it("reads the runs inside the window with every unmatched check, scoped and bounded", async () => {
  const f = setup();
  const result = await f.read(f.tx, { startsAt, endsAt });
  expect(result.runs).toHaveLength(1);
  expect(result.runs[0]?.counts).toEqual({
    Matched: 12,
    Healed: 1,
    Unresolved: 0,
    Unavailable: 0,
    Difference: 1,
  });
  expect(result.differences[0]).toMatchObject({
    outcome: "Difference",
    differenceReason: "RefundMismatch",
    providerRefundedMinor: "1130",
    exceptionReference: id(7),
  });
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize.mock.calls[0]?.[1]).toMatchObject({
    purpose: "ReadPaymentReconciliationWindow",
    startsAt,
    endsAt,
  });
  for (const [sql, params] of f.query.mock.calls as unknown as [string, unknown[]][])
    if (sql.includes("FROM rms_payment")) {
      expect(sql).toContain("brand_id=$1");
      expect(sql).toContain("store_id=$2");
      expect(params.slice(0, 2)).toEqual([id(2), id(3)]);
    }
});
it("reads no checks when the window has no run and still re-authorizes", async () => {
  const f = setup();
  f.rows.runs = [];
  const result = await f.read(f.tx, { startsAt, endsAt });
  expect(result).toMatchObject({ runs: [], differences: [] });
  expect(f.query).toHaveBeenCalledTimes(2);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("refuses a denied scope, an inverted window and corrupt rows", async () => {
  const denied = setup();
  denied.authorize.mockResolvedValue(false);
  await expect(denied.read(denied.tx, { startsAt, endsAt })).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
  const inverted = setup();
  await expect(
    inverted.read(inverted.tx, { startsAt: endsAt, endsAt: startsAt }),
  ).rejects.toThrow();
  for (const corrupt of [
    { outcome: "Matched" },
    { currency_code: "USD" },
    { run_reference: id(9) },
    { internal_captured_minor: 1130 },
  ]) {
    const f = setup();
    Object.assign(f.rows.checks[0] as object, corrupt);
    await expect(f.read(f.tx, { startsAt, endsAt })).rejects.toMatchObject({
      code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
    });
  }
});
