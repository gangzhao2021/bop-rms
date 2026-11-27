import { afterEach, expect, it, vi } from "vitest";
const records = vi.hoisted(() => [] as { event: string }[]);
const telemetry = vi.hoisted(() => ({ start: vi.fn(), shutdown: vi.fn(async () => "success") }));
vi.mock("@bop-rms/observability", () => ({
  createStructuredLogger: () => ({
    info: (record: { event: string }) => records.push(record),
    warn: (record: { event: string }) => records.push(record),
    error: (record: { event: string }) => records.push(record),
  }),
  createCoreTelemetry: () => undefined,
  createNodeTelemetryRuntime: () => telemetry,
}));
import { startWorkerRuntime } from "./index.js";
const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
  records.length = 0;
  vi.clearAllMocks();
});
it("fails without a workload and leaves no signal handlers or false started record", async () => {
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await startWorkerRuntime();
  expect(process.exitCode).toBe(1);
  expect(records.map((record) => record.event)).toEqual(["worker_start_failed"]);
  expect(telemetry.shutdown).toHaveBeenCalledOnce();
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});
it("cleans partially initialized workload when startup fails", async () => {
  const stop = vi.fn(async () => undefined);
  await startWorkerRuntime({
    workload: {
      start: async () => {
        throw new Error("synthetic startup failure");
      },
      stop,
    },
  });
  expect(stop).toHaveBeenCalledOnce();
  expect(records.map((record) => record.event)).not.toContain("worker_started");
  expect(process.exitCode).toBe(1);
});
it("starts a configured workload before success and drains once across both signals", async () => {
  const start = vi.fn(async () => {
    expect(records.map((record) => record.event)).not.toContain("worker_started");
  });
  const stop = vi.fn(async () => undefined);
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await startWorkerRuntime({ workload: { start, stop } });
  expect(start).toHaveBeenCalledOnce();
  expect(records.map((record) => record.event)).toEqual(["worker_started"]);
  process.emit("SIGTERM");
  process.emit("SIGINT");
  await vi.waitFor(() => expect(telemetry.shutdown).toHaveBeenCalledOnce());
  expect(stop).toHaveBeenCalledOnce();
  expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
});

it("waits for in-progress startup before shutdown and never announces started after a signal", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start = vi.fn(() => gate);
  const stop = vi.fn(async () => undefined);
  const running = startWorkerRuntime({ workload: { start, stop } });
  expect(start).toHaveBeenCalledOnce();
  process.emit("SIGTERM");
  expect(stop).not.toHaveBeenCalled();
  release();
  await running;
  expect(stop).toHaveBeenCalledOnce();
  expect(records.map((record) => record.event)).not.toContain("worker_started");
  expect(telemetry.shutdown).toHaveBeenCalledOnce();
});

it("stops and marks the process failed when the workload fails after startup", async () => {
  let finish!: (result: "failed") => void;
  const completion = new Promise<"failed">((resolve) => {
    finish = resolve;
  });
  const stop = vi.fn(async () => undefined);
  await startWorkerRuntime({ workload: { start: async () => undefined, stop, completion } });
  finish("failed");
  await vi.waitFor(() => expect(telemetry.shutdown).toHaveBeenCalledOnce());
  expect(stop).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(1);
  expect(records.map((record) => record.event)).toContain("worker_failed");
});

it("runs event polling and compensation together and drains both on compensation discovery failure", async () => {
  const { createOutboxWorkload } = await import("./outbox-workload.js");
  const { createPaymentCompensationWorkload } = await import("./payment-compensation-workload.js");
  let rejectDiscovery!: (reason: Error) => void;
  let discoveryCalls = 0;
  const discover = vi.fn(async () => {
    discoveryCalls++;
    if (discoveryCalls === 1)
      return {
        candidates: [{ dispositionReference: "synthetic-disposition" }],
        nextAfterDispositionReference: null,
      };
    return new Promise<{
      candidates: { dispositionReference: string }[];
      nextAfterDispositionReference: null;
    }>((_resolve, reject) => {
      rejectDiscovery = reject;
    });
  });
  const execute = vi.fn(async () => undefined);
  const dispatch = vi.fn(async () => 0);
  const drain = vi.fn(async () => "drained" as const);
  const eventWorkload = createOutboxWorkload({
    dispatcher: { runOnce: dispatch, stop: drain },
    pollIntervalMs: 5,
    drainDeadlineMs: 1000,
  });
  const compensation = createPaymentCompensationWorkload({
    discover,
    execute,
    recordFailure: vi.fn(async () => undefined),
    pageSize: 10,
    pollIntervalMs: 5,
    drainDeadlineMs: 1000,
  });
  const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
  await startWorkerRuntime({ workloads: [eventWorkload, compensation] });
  try {
    await vi.waitFor(() => expect(discoveryCalls).toBe(2));
    expect(execute).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls.length).toBeGreaterThan(1);
    rejectDiscovery(new Error("synthetic private database failure"));
    await vi.waitFor(() => expect(telemetry.shutdown).toHaveBeenCalledOnce());
    expect(process.exitCode).toBe(1);
    expect(drain).toHaveBeenCalledOnce();
    expect(await compensation.completion).toBe("failed");
    expect(await eventWorkload.completion).toBe("stopped");
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
  } finally {
    await Promise.all([eventWorkload.stop(), compensation.stop()]);
  }
});
