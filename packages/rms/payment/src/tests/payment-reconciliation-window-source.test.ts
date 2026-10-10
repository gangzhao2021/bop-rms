import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresPaymentReconciliationDaySource } from "../infrastructure/persistence/payment-reconciliation-window-source.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const startsAt = "2026-09-21T08:00:00.000Z",
  endsAt = "2026-09-22T08:00:00.000Z";
function setup() {
  const operationalRun: Record<string, unknown> = {
    run_reference: id(1),
    mode: "Operational",
    scheduled_at: new Date("2026-09-22T07:58:00.000Z"),
    cutoff_at: new Date("2026-09-22T07:58:00.000Z"),
    completed_at: new Date("2026-09-22T07:58:01.000Z"),
    matched_count: 12,
    healed_count: 1,
    unresolved_count: 1,
    unavailable_count: 0,
    difference_count: 0,
  };
  const settlementRun: Record<string, unknown> = {
    ...operationalRun,
    run_reference: id(5),
    mode: "DailySettlement",
    scheduled_at: new Date("2026-09-22T12:00:00.000Z"),
    cutoff_at: new Date("2026-09-22T12:00:00.000Z"),
    completed_at: new Date("2026-09-22T12:00:01.000Z"),
    matched_count: 1,
    healed_count: 0,
    unresolved_count: 0,
    difference_count: 0,
  };
  const unresolved: Record<string, unknown> = {
    check_reference: id(4),
    run_reference: id(1),
    checked_at: new Date("2026-09-22T07:58:00.500Z"),
    outcome: "Unresolved",
    difference_reason: null,
    settlement_reference: null,
    internal_status: "RequiresCustomerAction",
    provider_status: "RequiresCustomerAction",
    currency_code: "CAD",
    internal_captured_minor: "0",
    provider_captured_minor: "0",
    internal_refunded_minor: "0",
    provider_refunded_minor: "0",
    exception_reference: null,
  };
  const statement: Record<string, unknown> = {
    ...unresolved,
    check_reference: id(6),
    run_reference: id(5),
    checked_at: new Date("2026-09-22T12:00:00.500Z"),
    outcome: "Matched",
    settlement_reference: "SETTLE-2026-09-21",
    internal_status: null,
    provider_status: null,
    internal_captured_minor: "123450",
    provider_captured_minor: "123450",
    internal_refunded_minor: "1130",
    provider_refunded_minor: "1130",
  };
  const rows = {
    runCount: 240,
    latest: [operationalRun],
    outcomes: [
      { outcome: "Matched", payments: 13 },
      { outcome: "Unresolved", payments: 1 },
    ],
    differences: [unresolved],
    settlementRuns: [settlementRun],
    settlementChecks: [statement],
  };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("count(*)::int AS run_count")
      ? [{ run_count: rows.runCount }]
      : sql.includes("count(*)::int AS payments")
        ? rows.outcomes
        : sql.includes("WITH latest AS")
          ? rows.differences
          : sql.includes("mode='DailySettlement'")
            ? rows.settlementRuns
            : sql.includes("FROM rms_payment.payment_reconciliation_record r")
              ? rows.settlementChecks
              : sql.includes("FROM rms_payment.payment_reconciliation_run")
                ? rows.latest
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
    read: createPostgresPaymentReconciliationDaySource({
      scope: { brandReference: id(2), storeReference: id(3) },
      authorize,
    }),
  };
}
it("summarises the day's runs, counts each payment once and reads the day's settlement run", async () => {
  const f = setup();
  const result = await f.read(f.tx, { startsAt, endsAt, settlementRunReference: id(5) });
  expect(result.operational).toEqual({
    runCount: 240,
    latestRun: expect.objectContaining({ runReference: id(1), mode: "Operational" }),
    paymentCount: 14,
    outcomes: { Matched: 13, Healed: 0, Unresolved: 1, Unavailable: 0, Difference: 0 },
  });
  expect(result.differenceCount).toBe(1);
  expect(result.differences[0]).toMatchObject({
    outcome: "Unresolved",
    internalStatus: "RequiresCustomerAction",
    exceptionReference: null,
  });
  expect(result.settlement?.run.runReference).toBe(id(5));
  expect(result.settlement?.checks[0]).toMatchObject({
    outcome: "Matched",
    settlementReference: "SETTLE-2026-09-21",
    providerRefundedMinor: "1130",
  });
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize.mock.calls[0]?.[1]).toMatchObject({
    purpose: "ReadPaymentReconciliationDay",
    startsAt,
    endsAt,
  });
  for (const [sql, params] of f.query.mock.calls as unknown as [string, unknown[]][])
    if (sql.includes("FROM rms_payment")) {
      expect(sql).toContain("brand_id=$1");
      expect(sql).toContain("store_id=$2");
      expect(params.slice(0, 2)).toEqual([id(2), id(3)]);
    }
  const settlementRun = (f.query.mock.calls as unknown as [string, unknown[]][]).find(([sql]) =>
    sql.includes("mode='DailySettlement'"),
  );
  expect(settlementRun?.[1]).toEqual([id(2), id(3), id(5), endsAt]);
});
it("reads an empty day without a settlement and still re-authorizes", async () => {
  const f = setup();
  f.rows.runCount = 0;
  f.rows.latest = [];
  f.rows.outcomes = [];
  f.rows.settlementRuns = [];
  const result = await f.read(f.tx, { startsAt, endsAt, settlementRunReference: null });
  expect(result).toMatchObject({
    settlement: null,
    operational: {
      runCount: 0,
      latestRun: null,
      paymentCount: 0,
      outcomes: { Matched: 0, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
    },
    differences: [],
    differenceCount: 0,
  });
  // set_config, run count, latest run, per-payment outcomes; no differences or settlement query.
  expect(f.query).toHaveBeenCalledTimes(4);
  expect(f.authorize).toHaveBeenCalledTimes(2);
});
it("reports a day whose settlement run has not happened yet", async () => {
  const f = setup();
  f.rows.settlementRuns = [];
  const result = await f.read(f.tx, { startsAt, endsAt, settlementRunReference: id(5) });
  expect(result.settlement).toBeNull();
  expect(result.operational.runCount).toBe(240);
});
it("refuses a denied scope, an inverted window and corrupt rows", async () => {
  const denied = setup();
  denied.authorize.mockResolvedValue(false);
  await expect(
    denied.read(denied.tx, { startsAt, endsAt, settlementRunReference: null }),
  ).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED" });
  const inverted = setup();
  await expect(
    inverted.read(inverted.tx, {
      startsAt: endsAt,
      endsAt: startsAt,
      settlementRunReference: null,
    }),
  ).rejects.toThrow();
  for (const corrupt of [
    { outcome: "Matched" },
    { currency_code: "USD" },
    { internal_captured_minor: 0 },
  ]) {
    const f = setup();
    Object.assign(f.rows.differences[0] as object, corrupt);
    await expect(
      f.read(f.tx, { startsAt, endsAt, settlementRunReference: null }),
    ).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE" });
  }
  const foreign = setup();
  Object.assign(foreign.rows.settlementChecks[0] as object, { run_reference: id(9) });
  await expect(
    foreign.read(foreign.tx, { startsAt, endsAt, settlementRunReference: id(5) }),
  ).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE" });
  const empty = setup();
  empty.rows.settlementChecks = [];
  await expect(
    empty.read(empty.tx, { startsAt, endsAt, settlementRunReference: id(5) }),
  ).rejects.toMatchObject({ code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE" });
});
