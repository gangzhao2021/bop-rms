import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock("../../apps/worker/dist/payment-compensation-workload.js", () => ({
  createPaymentCompensationWorkload: d.factory,
}));
vi.mock("../../apps/worker/dist/outbox-workload.js", () => ({
  supervisedCycleFailures: { supervised: true },
}));
import { createOptionalCompensationWorkloads } from "./pilot-compensation-workload.mjs";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it("does not construct disabled service", async () => {
  const createService = vi.fn();
  expect(await createOptionalCompensationWorkloads({ enabled: false, createService })).toEqual([]);
  expect(createService).not.toHaveBeenCalled();
});
it("requires complete actual callbacks before enabling and forwards lifecycle observation", async () => {
  vi.stubEnv("NODE_ENV", "development");
  const service = {
      discover: vi.fn(),
      recoverProjectionPage: vi.fn(),
      execute: vi.fn(),
      afterExecute: vi.fn(),
      recordFailure: vi.fn(),
    },
    resources = {},
    onSnapshot = vi.fn();
  d.factory.mockReturnValue({ start: vi.fn() });
  const result = await createOptionalCompensationWorkloads({
    enabled: true,
    resources,
    onSnapshot,
    createService: async (value) => {
      expect(value).toBe(resources);
      return service;
    },
  });
  expect(result).toHaveLength(1);
  const opts = d.factory.mock.calls[0][0];
  expect(opts).toMatchObject({
    pageSize: 5,
    pollIntervalMs: 5000,
    drainDeadlineMs: 25000,
    onSnapshot,
    supervision: { supervised: true },
  });
  expect(service.execute).not.toHaveBeenCalled();
  expect(service.recoverProjectionPage).not.toHaveBeenCalled();
  await opts.discover({ limit: 5, afterDispositionReference: null });
  expect(service.recoverProjectionPage).toHaveBeenCalledTimes(1);
  expect(service.discover).toHaveBeenCalledTimes(1);
  // A failing repair is logged by safe code and never holds back refund discovery.
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  service.recoverProjectionPage.mockRejectedValueOnce(
    Error("PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE"),
  );
  service.discover.mockResolvedValueOnce("page");
  expect(await opts.discover({ limit: 5, afterDispositionReference: null })).toBe("page");
  expect(service.discover).toHaveBeenCalledTimes(2);
  service.recoverProjectionPage.mockRejectedValueOnce(Error("secret value 42"));
  await opts.discover({ limit: 5, afterDispositionReference: null });
  expect(errors.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    { event: "INTERNAL_COMPENSATION_REPAIR_FAILED", code: "PAYMENT_RECEIPT_COVERAGE_UNAVAILABLE" },
    { event: "INTERNAL_COMPENSATION_REPAIR_FAILED", code: null },
  ]);
  errors.mockRestore();
  await opts.afterExecute("candidate", "result");
  expect(service.afterExecute).toHaveBeenCalledWith("candidate", "result");
  await opts.recordFailure("candidate", "COMPENSATION_EXECUTION_FAILED");
  expect(service.recordFailure).toHaveBeenCalledWith("candidate", "COMPENSATION_EXECUTION_FAILED");
  await expect(
    createOptionalCompensationWorkloads({
      enabled: true,
      createService: async () => ({ discover: service.discover }),
    }),
  ).rejects.toThrow();
});
it("rejects production before service construction", async () => {
  vi.stubEnv("NODE_ENV", "production");
  const createService = vi.fn();
  await expect(
    createOptionalCompensationWorkloads({ enabled: true, createService }),
  ).rejects.toThrow();
  expect(createService).not.toHaveBeenCalled();
});
