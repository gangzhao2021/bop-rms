import { afterEach, expect, it, vi } from "vitest";
import { createOrdinaryRefundWorkload } from "./ordinary-refund-workload.js";
afterEach(() => vi.useRealTimers());
it("uses the journal-selected path and revisits reconciliation after a receipt failure", async () => {
  vi.useFakeTimers();
  const pending = { operationReference: "a", workKind: "Dispatch" as const };
  const sent = { operationReference: "a", workKind: "Reconcile" as const };
  const discover = vi
    .fn()
    .mockResolvedValueOnce({ candidates: [pending], nextAfterOperationReference: null })
    .mockResolvedValueOnce({ candidates: [sent], nextAfterOperationReference: null })
    .mockResolvedValueOnce({ candidates: [sent], nextAfterOperationReference: null })
    .mockResolvedValue({ candidates: [], nextAfterOperationReference: null });
  const dispatch = vi.fn(async () => undefined);
  const reconcile = vi.fn(async () => ({ status: "owner-outcome" }));
  const afterReconcile = vi
    .fn()
    .mockRejectedValueOnce(new Error("private-detail"))
    .mockResolvedValue(undefined);
  const recordFailure = vi.fn(async () => undefined);
  const workload = createOrdinaryRefundWorkload({
    discover,
    dispatch,
    reconcile,
    afterReconcile,
    recordFailure,
    pageSize: 2,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  await workload.start();
  await vi.advanceTimersByTimeAsync(20);
  expect(dispatch).toHaveBeenCalledExactlyOnceWith(pending);
  expect(reconcile).toHaveBeenCalledTimes(2);
  expect(afterReconcile).toHaveBeenCalledTimes(2);
  expect(recordFailure).toHaveBeenCalledExactlyOnceWith(sent, "ORDINARY_REFUND_EXECUTION_FAILED");
  await workload.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("drains active dispatch without processing the rest of the page or overlapping polls", async () => {
  vi.useFakeTimers();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = vi.fn(() => held);
  const reconcile = vi.fn(async () => undefined);
  const workload = createOrdinaryRefundWorkload({
    discover: async () => ({
      candidates: [
        { operationReference: "a", workKind: "Dispatch" as const },
        { operationReference: "b", workKind: "Reconcile" as const },
      ],
      nextAfterOperationReference: null,
    }),
    dispatch,
    reconcile,
    afterReconcile: async () => undefined,
    recordFailure: async () => undefined,
    pageSize: 2,
    pollIntervalMs: 10,
    drainDeadlineMs: 100,
  });
  const starting = workload.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = workload.stop();
  release();
  await starting;
  await stopping;
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(reconcile).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
