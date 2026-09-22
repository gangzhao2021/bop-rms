import { afterEach, beforeEach, expect, it, vi } from "vitest";
const d = vi.hoisted(() => ({ source: vi.fn(), binding: vi.fn(), read: vi.fn(), intent: vi.fn() }));
vi.mock("../../packages/rms/payment/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresPaymentReconciliationExceptionSource: d.source,
  createPostgresPaymentIntentBindingSource: d.binding,
}));
import {
  createInternalReconciliationExceptions,
  createInternalReconciliationExceptionPageRunner,
} from "./pilot-reconciliation-exceptions.mjs";
const id = (n) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T00:00:00.000Z",
  end = "2026-09-22T00:00:00.000Z";
function setup() {
  const tx = {},
    scope = { brandReference: id(1), storeReference: id(2) },
    now = vi.fn(() => at);
  const resources = {
    scope,
    publicProfile: { binding: { ...scope, tenantReference: id(3), validUntil: end } },
    now,
    transactions: { run: (work) => work(tx) },
  };
  return { tx, scope, now, resources };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("NODE_ENV", "development");
  d.source.mockReturnValue(d.read);
  d.binding.mockReturnValue(d.intent);
  d.read.mockResolvedValue({ items: [], nextAfterExceptionReference: null });
});
afterEach(() => vi.unstubAllEnvs());
it("constructs without queries and binds same transaction, scope and observation time", async () => {
  const f = setup();
  const read = createInternalReconciliationExceptions(f.resources);
  expect(d.source).not.toHaveBeenCalled();
  d.read.mockImplementationOnce(async (tx, input) => {
    expect(tx).toBe(f.tx);
    expect(input.limit).toBe(5);
    const source = d.source.mock.calls[0][0],
      binding = d.binding.mock.calls[0][0];
    expect(binding.scope).toEqual({ ...f.scope, tenantReference: id(3), environment: "Test" });
    expect(await source.authorize(tx, { ...f.scope, purpose: "ProjectOrderException" })).toBe(true);
    expect(await binding.authorize(tx, { ...binding.scope, observedAt: at })).toBe(true);
    await source.resolveIntent(tx, id(4));
    expect(d.intent).toHaveBeenCalledWith(tx, { paymentIntentReference: id(4), observedAt: at });
    return { items: [], nextAfterExceptionReference: null };
  });
  await read({ afterExceptionReference: null, limit: 5 });
  expect(
    await d.source.mock.calls[0][0].authorize(f.tx, {
      ...f.scope,
      purpose: "ProjectOrderException",
    }),
  ).toBe(false);
  await expect(d.source.mock.calls[0][0].resolveIntent(f.tx, id(4))).rejects.toThrow();
});
it("rejects wrong transaction, scope, purpose and Live environment", async () => {
  const f = setup();
  d.read.mockImplementationOnce(async () => {
    const source = d.source.mock.calls[0][0],
      binding = d.binding.mock.calls[0][0];
    expect(await source.authorize({}, { ...f.scope, purpose: "ProjectOrderException" })).toBe(
      false,
    );
    expect(
      await source.authorize(f.tx, {
        ...f.scope,
        storeReference: id(99),
        purpose: "ProjectOrderException",
      }),
    ).toBe(false);
    expect(await source.authorize(f.tx, { ...f.scope, purpose: "Other" })).toBe(false);
    expect(
      await binding.authorize(f.tx, { ...binding.scope, observedAt: at, environment: "Live" }),
    ).toBe(false);
    await expect(source.resolveIntent({}, id(4))).rejects.toThrow();
    return {};
  });
  await createInternalReconciliationExceptions(f.resources)({
    limit: 5,
    afterExceptionReference: null,
  });
});
it("rejects expired or production configuration and expiry during owner read", async () => {
  const f = setup();
  f.now.mockReturnValue(end);
  expect(() => createInternalReconciliationExceptions(f.resources)).toThrow();
  f.now.mockReturnValue(at);
  const read = createInternalReconciliationExceptions(f.resources);
  d.read.mockImplementationOnce(async () => {
    f.now.mockReturnValue(end);
    return {};
  });
  await expect(read({ limit: 5, afterExceptionReference: null })).rejects.toThrow();
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createInternalReconciliationExceptions(f.resources)).toThrow();
});
it("rejects scope mismatch and propagates owner failure without fallback rows", async () => {
  const f = setup();
  f.resources.publicProfile.binding.storeReference = id(99);
  expect(() => createInternalReconciliationExceptions(f.resources)).toThrow();
  f.resources.publicProfile.binding.storeReference = id(2);
  d.read.mockRejectedValueOnce(Error("owner unavailable"));
  await expect(
    createInternalReconciliationExceptions(f.resources)({
      limit: 5,
      afterExceptionReference: null,
    }),
  ).rejects.toThrow("owner unavailable");
});

it("retains the transaction only during projection consumption and propagates consumer failure", async () => {
  const f = setup();
  let retained;
  const run = createInternalReconciliationExceptionPageRunner(f.resources, async (context) => {
    retained = context;
    expect(context.tx).toBe(f.tx);
    expect(context.authorize()).toBe(true);
    await context.reread();
    throw Error("projection failed");
  });
  await expect(run({ limit: 5, afterExceptionReference: null })).rejects.toThrow(
    "projection failed",
  );
  expect(retained.authorize()).toBe(false);
  await expect(retained.reread()).rejects.toThrow();
  expect(d.read).toHaveBeenCalledTimes(2);
});
