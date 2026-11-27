import { expect, it, vi } from "vitest";
import { createDailySettlementScheduler } from "./pilot-daily-settlement-scheduler.mjs";
const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-22T04:30:00.000Z",
  money = { amountMinor: 0n, currencyCode: "CAD" };
function fixture() {
  const scope = { brandReference: id(1), storeReference: id(2) },
    window = {
      ...scope,
      businessDate: "2026-09-20",
      startsAt: "2026-09-20T08:00:00.000Z",
      endsAt: "2026-09-21T08:00:00.000Z",
    };
  const candidate = {
    ...scope,
    candidateReference: id(3),
    businessDate: window.businessDate,
    settlementReference: "simset_20260920_" + "a".repeat(64),
    internalCapturedAmount: money,
    providerCapturedAmount: money,
    internalRefundedAmount: money,
    providerRefundedAmount: money,
    evidenceObservedAt: at,
  };
  let saved = null;
  const ports = {
    scope,
    now: () => at,
    readWindow: vi.fn(async () => ({ ...window })),
    prepare: vi.fn(async () => ({
      candidate: { ...candidate },
      sources: { window: { ...window } },
    })),
    readRun: vi.fn(async () => saved),
    execute: vi.fn(async (run, c) => {
      saved = {
        run,
        status: "Completed",
        completedAt: at,
        counts: { Matched: 1, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
        exceptions: [],
        checks: [
          {
            checkReference: id(4),
            runReference: run.runReference,
            candidateReference: c.candidateReference,
            ...scope,
            mode: "DailySettlement",
            paymentIntentReference: null,
            settlementReference: c.settlementReference,
            outcome: "Matched",
            differenceReason: null,
            internalStatus: null,
            providerStatus: null,
            internalCapturedAmount: money,
            providerCapturedAmount: money,
            internalRefundedAmount: money,
            providerRefundedAmount: money,
            exceptionReference: null,
            safeCode: null,
            checkedAt: at,
          },
        ],
      };
      return { status: "Created", result: saved };
    }),
  };
  return { ports, window, candidate, make: () => createDailySettlementScheduler(ports) };
}
it("creates once, idles and after restart reads durable completion without Provider preparation", async () => {
  const f = fixture(),
    tick = f.make();
  expect(await tick()).toEqual({ status: "Created", checkCount: 1 });
  expect(await tick()).toEqual({ status: "Idle", checkCount: 0 });
  expect(await f.make()()).toEqual({ status: "Duplicate", checkCount: 1 });
  expect(f.ports.prepare).toHaveBeenCalledTimes(1);
  expect(f.ports.execute).toHaveBeenCalledTimes(1);
});
it("keeps the identical pending run and candidate when execution fails before commit", async () => {
  const f = fixture(),
    tick = f.make();
  f.ports.execute.mockRejectedValueOnce(Error("offline"));
  await expect(tick()).rejects.toThrow();
  expect((await tick()).status).toBe("Created");
  expect(f.ports.execute.mock.calls[0]).toEqual(f.ports.execute.mock.calls[1]);
  expect(f.ports.prepare).toHaveBeenCalledTimes(1);
});
it("recovers committed but unacknowledged work from durable state", async () => {
  const f = fixture(),
    execute = f.ports.execute.getMockImplementation();
  f.ports.execute.mockImplementationOnce(async (...args) => {
    await execute(...args);
    throw Error("lost reply");
  });
  const tick = f.make();
  await expect(tick()).rejects.toThrow();
  expect((await tick()).status).toBe("Duplicate");
  expect(f.ports.execute).toHaveBeenCalledTimes(1);
});
it("rejects wrong owner scope, unclosed windows and crossed window preparation", async () => {
  const f = fixture();
  f.window.storeReference = id(9);
  await expect(f.make()()).rejects.toThrow();
  f.window.storeReference = id(2);
  f.window.endsAt = "2026-09-23T08:00:00.000Z";
  await expect(f.make()()).rejects.toThrow();
  f.window.endsAt = "2026-09-21T08:00:00.000Z";
  f.candidate.businessDate = "2026-09-19";
  await expect(f.make()()).rejects.toThrow();
  expect(f.ports.execute).not.toHaveBeenCalled();
});
it("rejects future evidence and persisted wrong scope", async () => {
  const f = fixture();
  f.candidate.evidenceObservedAt = "2026-09-23T00:00:00.000Z";
  await expect(f.make()()).rejects.toThrow();
  f.candidate.evidenceObservedAt = at;
  await f.make()();
  const saved = await f.ports.readRun();
  f.ports.readRun.mockResolvedValue({ ...saved, run: { ...saved.run, storeReference: id(9) } });
  await expect(f.make()()).rejects.toThrow();
});
it("rejects overlapping ticks without losing the original execution", async () => {
  const f = fixture();
  let release;
  f.ports.readWindow.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(f.window);
      }),
  );
  const tick = f.make(),
    first = tick();
  await expect(tick()).rejects.toThrow();
  release();
  expect((await first).status).toBe("Created");
});

it("finishes a failed old-day command after the next window closes", async () => {
  const f = fixture(),
    tick = f.make();
  f.ports.execute.mockRejectedValueOnce(Error("offline"));
  await expect(tick()).rejects.toThrow();
  f.ports.readWindow.mockRejectedValue(Error("new day lookup must wait"));
  expect((await tick()).status).toBe("Created");
  expect(f.ports.prepare).toHaveBeenCalledTimes(1);
});
