import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  release: vi.fn(),
  port: vi.fn(),
  workload: vi.fn(),
  discover: vi.fn(),
  close: vi.fn(),
  closure: vi.fn(),
}));
vi.mock("../../packages/rms/ordering/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresPaidAcceptanceLapseClosure: (options) => {
    d.closure(options);
    return { close: d.close };
  },
}));
vi.mock("../../apps/api/dist/paid-without-fulfillable-inventory-release.js", () => ({
  createPaidWithoutFulfillableInventoryRelease: (options) => {
    d.release(options);
    return d.port;
  },
}));
vi.mock("../../apps/worker/dist/payment-compensation-workload.js", () => ({
  createPaymentCompensationWorkload: d.workload,
}));
vi.mock("./pilot-compensation-candidates.mjs", () => ({
  createInternalCompensationCandidates: () => ({ discover: d.discover }),
}));
import {
  createInternalPaidWithoutFulfillableInventory,
  createInternalPaidWithoutFulfillableInventoryWorkload,
} from "./pilot-paid-without-fulfillable-inventory.mjs";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const ref = (n) => "0190fa01-0000-7000-8000-" + String(n).padStart(12, "0");
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const scope = { brandReference: ref(2), storeReference: ref(3) };
  const tx = {};
  const resources = {
    scope,
    publicProfile: {
      binding: { tenantReference: ref(1), ...scope, validUntil: "2026-09-22T00:00:00.000Z" },
    },
    now: vi.fn(() => "2026-09-21T00:00:00.000Z"),
    transactions: { run: vi.fn((work) => work(tx)) },
    credentials: { reference: vi.fn(() => ref(50)) },
  };
  return { resources, tx, scope };
}
it("composes the owner release with the binding scope, System actor and one transaction", async () => {
  const f = fixture();
  const service = createInternalPaidWithoutFulfillableInventory(f.resources, {
    systemActorReference: ref(9),
  });
  const options = d.release.mock.calls[0][0];
  expect(options).toMatchObject({
    scope: { tenantReference: ref(1), ...f.scope },
    systemActorReference: ref(9),
  });
  const disposition = { ...f.scope, dispositionReference: ref(20) };
  expect(await options.authorize(f.tx, disposition)).toBe(true);
  expect(await options.authorize(f.tx, { ...disposition, storeReference: ref(99) })).toBe(false);
  d.port.mockResolvedValue({ status: "Released", entryCount: 1 });
  expect(await service.release(disposition)).toEqual({ status: "Released", entryCount: 1 });
  expect(d.port).toHaveBeenCalledWith(f.tx, disposition);
  expect(f.resources.transactions.run).toHaveBeenCalledTimes(1);
  await service.discover({ afterDispositionReference: null, limit: 10 });
  expect(d.discover).toHaveBeenCalledWith({ afterDispositionReference: null, limit: 10 });
  f.resources.now.mockReturnValue("2026-09-22T00:00:00.000Z");
  expect(await options.authorize(f.tx, disposition)).toBe(false);
  expect(() => service.release(disposition)).toThrow(
    "INTERNAL_PAID_WITHOUT_FULFILLABLE_INVENTORY_UNAVAILABLE",
  );
  expect(f.resources.transactions.run).toHaveBeenCalledTimes(1);
});
it("also closes a pickup the Store did not accept in time, in the release transaction (WP-2423)", async () => {
  const f = fixture();
  const service = createInternalPaidWithoutFulfillableInventory(f.resources, {
    systemActorReference: ref(9),
  });
  expect(d.closure.mock.calls[0][0]).toMatchObject(f.scope);
  d.port.mockResolvedValue({ status: "Released", entryCount: 1 });
  d.close.mockResolvedValue({ status: "Closed" });
  const lapsed = { ...f.scope, reason: "CapacityExpired", paymentEventReference: ref(21) };
  expect(await service.release(lapsed)).toEqual({ status: "Released", entryCount: 1 });
  expect(d.close).toHaveBeenCalledWith(f.tx, {
    paymentEventReference: ref(21),
    closedAt: "2026-09-21T00:00:00.000Z",
    terminationReference: ref(50),
    auditReference: ref(50),
  });
  await service.release({ ...lapsed, reason: "SubmissionCancelled" });
  expect(d.close).toHaveBeenCalledTimes(1);
  d.close.mockRejectedValue(new Error("ORDER_TERMINATION_UNAVAILABLE"));
  await expect(service.release(lapsed)).rejects.toThrow("ORDER_TERMINATION_UNAVAILABLE");
});
it("rejects production and a mismatched binding before composing the release", () => {
  const f = fixture();
  expect(() =>
    createInternalPaidWithoutFulfillableInventory(
      { ...f.resources, scope: { ...f.scope, storeReference: ref(99) } },
      { systemActorReference: ref(9) },
    ),
  ).toThrow("INTERNAL_PAID_WITHOUT_FULFILLABLE_INVENTORY_UNAVAILABLE");
  vi.stubEnv("NODE_ENV", "production");
  expect(() =>
    createInternalPaidWithoutFulfillableInventory(f.resources, { systemActorReference: ref(9) }),
  ).toThrow("INTERNAL_PAID_WITHOUT_FULFILLABLE_INVENTORY_UNAVAILABLE");
  expect(d.release).not.toHaveBeenCalled();
});
it("polls owner discovery and executes each candidate through the idempotent release", async () => {
  const f = fixture();
  const service = { discover: vi.fn(), release: vi.fn() },
    onSnapshot = vi.fn(),
    createService = vi.fn(() => service);
  d.workload.mockReturnValue({ start: vi.fn() });
  createInternalPaidWithoutFulfillableInventoryWorkload(
    f.resources,
    onSnapshot,
    { systemActorReference: ref(9) },
    { createService },
  );
  expect(createService).toHaveBeenCalledWith(f.resources, { systemActorReference: ref(9) });
  const opts = d.workload.mock.calls[0][0];
  expect(opts).toMatchObject({ pageSize: 10, pollIntervalMs: 5000, drainDeadlineMs: 25000 });
  // WP-2423 pilot resilience: a failed cycle retries instead of stopping the business worker.
  expect(opts.supervision).toBeDefined();
  expect(opts.onSnapshot).toBe(onSnapshot);
  await opts.discover({ afterDispositionReference: null, limit: 10 });
  expect(service.discover).toHaveBeenCalledWith({ afterDispositionReference: null, limit: 10 });
  await opts.execute("candidate");
  expect(service.release).toHaveBeenCalledWith("candidate");
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  await opts.afterExecute("candidate", { status: "NotReleasable", reason: "ProductionStarted" });
  await opts.afterExecute("candidate", { status: "Released", entryCount: 1 });
  await opts.recordFailure("candidate", "COMPENSATION_EXECUTION_FAILED");
  expect(error.mock.calls.map((c) => JSON.parse(c[0]))).toEqual([
    { event: "INTERNAL_INVENTORY_RELEASE_LEFT", reason: "ProductionStarted" },
    { event: "INTERNAL_INVENTORY_RELEASE_FAILED", code: "COMPENSATION_EXECUTION_FAILED" },
  ]);
  error.mockRestore();
});
