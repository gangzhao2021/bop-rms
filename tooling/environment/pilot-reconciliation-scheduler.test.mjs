import { expect, it, vi } from "vitest";
import { createOperationalReconciliationScheduler } from "./pilot-reconciliation-scheduler.mjs";
const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-22T00:01:12.000Z";
function result(run, count) {
  const money = { amountMinor: 0n, currencyCode: "CAD" };
  return {
    status: "Created",
    result: {
      run,
      status: "Completed",
      completedAt: run.scheduledAt,
      counts: { Matched: count, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
      exceptions: [],
      checks: Array.from({ length: count }, (_, i) => ({
        checkReference: id(100 + i),
        runReference: run.runReference,
        candidateReference: id(300 + i),
        mode: "Operational",
        brandReference: run.brandReference,
        storeReference: run.storeReference,
        paymentIntentReference: id(500 + i),
        settlementReference: null,
        outcome: "Matched",
        differenceReason: null,
        internalStatus: "Failed",
        providerStatus: "Failed",
        internalCapturedAmount: money,
        providerCapturedAmount: money,
        internalRefundedAmount: money,
        providerRefundedAmount: money,
        exceptionReference: null,
        safeCode: null,
        checkedAt: run.scheduledAt,
      })),
    },
  };
}
function fixture() {
  const ports = {
    scope: { brandReference: id(1), storeReference: id(2) },
    now: vi.fn(() => at),
    readRun: vi.fn(async () => null),
    hasDue: vi.fn(async () => true),
    execute: vi.fn(async (run) => result(run, 2)),
  };
  return { ...ports, make: () => createOperationalReconciliationScheduler(ports) };
}
it("does not append empty runs or repeatedly scan a finished minute", async () => {
  const f = fixture(),
    tick = f.make();
  f.hasDue.mockResolvedValue(false);
  expect(await tick()).toEqual({ status: "Idle", checkCount: 0 });
  await tick();
  expect(f.hasDue).toHaveBeenCalledTimes(1);
  expect(f.execute).not.toHaveBeenCalled();
  f.now.mockReturnValue("2026-09-22T00:02:00.000Z");
  await tick();
  expect(f.hasDue).toHaveBeenCalledTimes(2);
});
it("uses stable minute identity after restart and replays persisted run before due probing", async () => {
  const f = fixture();
  await f.make()();
  const run = f.execute.mock.calls[0][0];
  f.readRun.mockResolvedValue({ persisted: true });
  f.hasDue.mockClear();
  await f.make()();
  expect(f.execute.mock.calls[1][0]).toEqual(run);
  expect(f.hasDue).not.toHaveBeenCalled();
});
it("drains full pages with distinct deterministic identities before completing the slot", async () => {
  const f = fixture(),
    tick = f.make();
  f.execute.mockImplementationOnce(async (run) => result(run, 100));
  expect((await tick()).checkCount).toBe(100);
  await tick();
  const a = f.execute.mock.calls[0][0],
    b = f.execute.mock.calls[1][0];
  expect(a.runReference).not.toBe(b.runReference);
  expect(a.scheduledAt).toBe(b.scheduledAt);
  await tick();
  expect(f.execute).toHaveBeenCalledTimes(2);
});
it("preserves run identity and page after failure", async () => {
  const f = fixture(),
    tick = f.make();
  f.execute.mockRejectedValueOnce(Error("unavailable"));
  await expect(tick()).rejects.toThrow();
  await tick();
  expect(f.execute.mock.calls[0][0]).toEqual(f.execute.mock.calls[1][0]);
});
it("rejects malformed due evidence and wrong result scope", async () => {
  const f = fixture();
  f.hasDue.mockResolvedValue(undefined);
  await expect(f.make()()).rejects.toThrow();
  f.hasDue.mockResolvedValue(true);
  f.execute.mockImplementation(async (run) => result({ ...run, storeReference: id(99) }, 1));
  await expect(f.make()()).rejects.toThrow();
});
it("does not allow overlapping execution", async () => {
  const f = fixture(),
    tick = f.make();
  let finish;
  f.readRun.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = tick();
  await expect(tick()).rejects.toThrow();
  finish(null);
  await first;
});
