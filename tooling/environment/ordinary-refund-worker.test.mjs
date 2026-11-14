import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createConfiguredOrdinaryRefundWorker } from "./ordinary-refund-worker.mjs";
const f = vi.hoisted(() => ({ processing: vi.fn(), failure: vi.fn() }));
vi.mock("../../apps/api/dist/ordinary-refund-processing.js", () => ({
  createOrdinaryRefundProcessing: f.processing,
}));
vi.mock("../../apps/api/dist/ordinary-refund-failure-recorder.js", () => ({
  createOrdinaryRefundFailureRecorder: f.failure,
}));
beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
function setup() {
  const candidate = { operationReference: "a", workKind: "Dispatch" };
  const ports = {
    discover: vi
      .fn()
      .mockResolvedValueOnce({ candidates: [candidate], nextAfterOperationReference: null })
      .mockResolvedValue({ candidates: [], nextAfterOperationReference: null }),
    dispatch: vi.fn(async () => undefined),
    reconcile: vi.fn(),
    afterReconcile: vi.fn(),
  };
  const record = vi.fn(async () => undefined);
  f.processing.mockReturnValue(ports);
  f.failure.mockReturnValue(record);
  const resource = {
    processing: {
      payment: { dispatch: { scope: { brandReference: "configured" } }, transactions: {} },
    },
    failure: { scope: { brandReference: "injected" }, transactions: { injected: true } },
    close: vi.fn(async () => undefined),
  };
  const open = vi.fn(async () => resource);
  const create = () =>
    createConfiguredOrdinaryRefundWorker({
      open,
      pageSize: 1,
      pollIntervalMs: 10,
      drainDeadlineMs: 100,
    });
  return { ports, record, resource, open, create, candidate };
}
it("opens lazily and binds durable failure recording to the same scope and transaction runner", async () => {
  vi.useFakeTimers();
  const x = setup();
  const w = x.create();
  expect(x.open).not.toHaveBeenCalled();
  x.ports.dispatch.mockRejectedValueOnce(new Error("private provider detail"));
  await w.start();
  expect(x.record).toHaveBeenCalledExactlyOnceWith(x.candidate, "ORDINARY_REFUND_EXECUTION_FAILED");
  expect(f.failure.mock.calls[0][0].scope).toBe(x.resource.processing.payment.dispatch.scope);
  expect(f.failure.mock.calls[0][0].transactions).toBe(x.resource.processing.payment.transactions);
  await w.stop();
  await w.stop();
  expect(x.resource.close).toHaveBeenCalledTimes(1);
  await expect(w.completion).resolves.toBe("stopped");
  expect(vi.getTimerCount()).toBe(0);
});
it("drains active work before closing resources", async () => {
  vi.useFakeTimers();
  const x = setup();
  let release;
  x.ports.dispatch.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const w = x.create();
  const starting = w.start();
  await vi.advanceTimersByTimeAsync(0);
  const stopping = w.stop();
  expect(x.resource.close).not.toHaveBeenCalled();
  release();
  await starting;
  await stopping;
  expect(x.resource.close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("stop during acquisition prevents polling and closes the acquired resource", async () => {
  const x = setup();
  let release;
  x.open.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const w = x.create();
  const starting = w.start();
  const stopping = w.stop();
  release(x.resource);
  await starting;
  await stopping;
  expect(f.processing).not.toHaveBeenCalled();
  expect(x.resource.close).toHaveBeenCalledTimes(1);
});
it("failed assembly closes once and cleanup failure remains observable", async () => {
  const x = setup();
  f.processing.mockImplementation(() => {
    throw new Error("private config");
  });
  const w = x.create();
  await expect(w.start()).rejects.toThrow("ORDINARY_REFUND_WORKER_START_FAILED");
  await w.stop();
  expect(x.resource.close).toHaveBeenCalledTimes(1);
  await expect(w.completion).resolves.toBe("failed");
  const y = setup();
  y.resource.close.mockRejectedValue(new Error("private cleanup"));
  const other = y.create();
  await other.start();
  await expect(other.stop()).rejects.toThrow("ORDINARY_REFUND_WORKER_CLOSE_FAILED");
  await expect(other.completion).resolves.toBe("failed");
});
