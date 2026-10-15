import console from "node:console";
import { afterEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({
  closure: vi.fn(),
  dispatcher: vi.fn(),
  workload: vi.fn(),
}));
vi.mock("../../apps/api/dist/pickup-payment-window-closure.js", () => ({
  createPickupPaymentWindowClosure: (options) => {
    d.closure(options);
    return { discover: vi.fn(), close: vi.fn() };
  },
  createPickupPaymentWindowDispatcher: (options) => {
    d.dispatcher(options);
    return { runOnce: vi.fn(), stop: vi.fn() };
  },
}));
vi.mock("../../apps/worker/dist/outbox-workload.js", () => ({
  createOutboxWorkload: d.workload,
  supervisedCycleFailures: { supervised: true },
}));
import {
  createInternalPickupPaymentExpiry,
  createInternalPickupPaymentExpiryWorkload,
} from "./pilot-pickup-payment-expiry.mjs";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
const ref = (n) => "0190fa01-0000-7000-8000-" + String(n).padStart(12, "0");
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const scope = { brandReference: ref(2), storeReference: ref(3) };
  const resources = {
    scope,
    publicProfile: {
      binding: { tenantReference: ref(1), ...scope, validUntil: "2026-09-22T00:00:00.000Z" },
    },
    now: vi.fn(() => "2026-09-21T00:00:00.000Z"),
    transactions: { run: vi.fn() },
    credentials: { reference: vi.fn() },
  };
  return { resources, scope };
}
const options = { systemActorReference: ref(9), providerAccountReference: ref(8) };
it("composes the closure with the binding scope, Test provider account and System actor", async () => {
  const f = fixture();
  createInternalPickupPaymentExpiry(f.resources, options);
  const composed = d.closure.mock.calls[0][0];
  expect(composed).toMatchObject({
    scope: {
      tenantReference: ref(1),
      ...f.scope,
      providerAccountReference: ref(8),
      environment: "Test",
    },
    systemActorReference: ref(9),
    transactions: f.resources.transactions,
    newReference: f.resources.credentials.reference,
  });
  expect(await composed.authorize({}, {})).toBe(true);
  expect(await composed.authorizeDiscovery({}, "2026-09-21T00:00:00.000Z")).toBe(true);
  // A discovery instant from the future is never authorized.
  expect(await composed.authorizeDiscovery({}, "2026-09-21T00:00:01.000Z")).toBe(false);
  f.resources.now.mockReturnValue("2026-09-22T00:00:00.000Z");
  expect(await composed.authorize({}, {})).toBe(false);
});
it("rejects production and a mismatched binding before composing the closure", () => {
  const f = fixture();
  expect(() =>
    createInternalPickupPaymentExpiry(
      { ...f.resources, scope: { ...f.scope, storeReference: ref(99) } },
      options,
    ),
  ).toThrow("INTERNAL_PICKUP_PAYMENT_EXPIRY_UNAVAILABLE");
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createInternalPickupPaymentExpiry(f.resources, options)).toThrow(
    "INTERNAL_PICKUP_PAYMENT_EXPIRY_UNAVAILABLE",
  );
  expect(d.closure).not.toHaveBeenCalled();
});
it("polls through the dispatcher and reports stock left or failures without identifiers", () => {
  const f = fixture();
  const service = { discover: vi.fn(), close: vi.fn() };
  const createService = vi.fn(() => service);
  d.workload.mockReturnValue("workload");
  const observer = vi.fn();
  expect(
    createInternalPickupPaymentExpiryWorkload(f.resources, observer, options, { createService }),
  ).toBe("workload");
  expect(createService).toHaveBeenCalledWith(f.resources, options);
  const dispatch = d.dispatcher.mock.calls[0][0];
  expect(dispatch).toMatchObject({ closure: service, now: f.resources.now, pageSize: 10 });
  expect(d.workload.mock.calls[0][0]).toMatchObject({
    supervision: { supervised: true },
    pollIntervalMs: 15000,
    drainDeadlineMs: 25000,
    onSnapshot: observer,
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  dispatch.onOutcome({
    status: "Closed",
    paymentEvidence: "NoPaymentStarted",
    inventory: { status: "Released", entryCount: 1 },
  });
  expect(error).not.toHaveBeenCalled();
  dispatch.onOutcome({
    status: "Closed",
    paymentEvidence: "NoPaymentStarted",
    inventory: { status: "NotReleasable", reason: "ProductionStarted" },
  });
  dispatch.onFailure("PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE");
  expect(error.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    { event: "INTERNAL_PICKUP_PAYMENT_EXPIRY_STOCK_LEFT", reason: "ProductionStarted" },
    {
      event: "INTERNAL_PICKUP_PAYMENT_EXPIRY_FAILED",
      code: "PICKUP_PAYMENT_WINDOW_CLOSURE_UNAVAILABLE",
    },
  ]);
  error.mockRestore();
});
