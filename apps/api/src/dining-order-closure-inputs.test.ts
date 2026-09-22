import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  cancellation: vi.fn(),
  priced: vi.fn(),
  execution: vi.fn(),
  financial: vi.fn(),
  tasks: vi.fn(),
}));
vi.mock("@rms/ordering", () => ({
  createPostgresOrderCancellationRequestStore: () => ({ loadPosition: mocks.cancellation }),
  createPostgresOrderPricedAmountSource: () => mocks.priced,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresOrderFinancialPosition: () => mocks.financial,
}));
vi.mock("./dining-order-execution-position.js", () => ({
  createDiningOrderExecutionPosition: () => ({ load: mocks.execution }),
}));
vi.mock("./dining-order-task-position.js", () => ({
  createDiningOrderTaskPosition: () => ({ load: mocks.tasks }),
}));
import { createDiningOrderClosureInputs } from "./dining-order-closure-inputs.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    base = {
      ...scope,
      orderReference: id(4),
      observedAt: "2026-09-20T00:00:00.000Z",
      snapshotDigest: "sha256:" + "a".repeat(64),
    };
  const cancellation = { ...base, pendingCount: 0 },
    priced = { ...base, pricedTotalMinor: 100n, pendingAmendmentCount: 0 },
    execution = { ...base, orderVersion: 3, phase: "Fulfilled" };
  const financial = {
    ...base,
    providerAccountReference: id(7),
    environment: "Test",
    currencyCode: "CAD",
    capturedMinor: 110n,
    capturedOrderAllocationMinor: 100n,
    capturedTipMinor: 10n,
    confirmedRefundMinor: 0n,
    pendingRefundMinor: 0n,
    unresolvedAttemptCount: 0,
  };
  const tasks = { execution, snapshotDigest: base.snapshotDigest, taskSources: [] };
  for (const [key, value] of Object.entries({ cancellation, priced, execution, financial, tasks }))
    mocks[key as keyof typeof mocks].mockResolvedValue(value);
  const authorize = vi.fn(async () => true),
    input = {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      transaction: { query: vi.fn() },
      orderReference: id(4),
      diningSessionReference: id(5),
      guestSessionReference: id(6),
      observedAt: base.observedAt,
    };
  const reader = createDiningOrderClosureInputs({
    ...scope,
    diningScope: scope,
    paymentScope: { ...scope, providerAccountReference: id(7), environment: "Test" },
    authorize,
    authorizeKitchen: authorize,
    authorizeDining: authorize,
  });
  return {
    cancellation,
    priced,
    execution,
    financial,
    tasks,
    authorize,
    load: () => reader.load(input),
  };
}
it("combines current facts with exact settlement while preserving cancellation separately", async () => {
  const f = setup();
  f.cancellation.pendingCount = 1;
  const result = await f.load();
  expect(result?.settlement.classification).toBe("Settled");
  expect(result?.cancellation.pendingCount).toBe(1);
  expect(result).not.toHaveProperty("eligible");
  const calls = Object.values(mocks).map((m) => m.mock.invocationCallOrder[0] ?? -1);
  expect(calls).toEqual([...calls].sort((a, b) => a - b));
});
it.each(["cancellation", "priced", "execution", "financial"] as const)(
  "rejects mixed %s observation",
  async (key) => {
    const f = setup();
    f[key].observedAt = "2026-09-21T00:00:00.000Z";
    await expect(f.load()).rejects.toThrow();
  },
);
it("rejects execution drift across task composition", async () => {
  const f = setup();
  f.tasks.execution = { ...f.execution, snapshotDigest: "sha256:" + "b".repeat(64) };
  await expect(f.load()).rejects.toThrow();
});
it("retains pending refunds as unsettled", async () => {
  const f = setup();
  f.financial.pendingRefundMinor = 10n;
  expect((await f.load())?.settlement.classification).toBe("Indeterminate");
});
it("missing cancellation source cannot become zero", async () => {
  const f = setup();
  mocks.cancellation.mockRejectedValue(new Error("table unavailable"));
  await expect(f.load()).rejects.toThrow();
  expect(mocks.financial).not.toHaveBeenCalled();
});
it("unavailable execution cannot be closed", async () => {
  const f = setup();
  mocks.execution.mockResolvedValue(null);
  expect(await f.load()).toBeNull();
  expect(mocks.financial).not.toHaveBeenCalled();
});
it("rechecks authority after evidence", async () => {
  const f = setup();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow();
});

it("passes proven refund allocation to settlement without changing original price", async () => {
  const f = setup();
  mocks.financial.mockResolvedValue({
    ...f.financial,
    confirmedRefundMinor: 55n,
    refundAllocation: { orderMinor: 50n, tipMinor: 5n, unallocatedMinor: 0n },
  });
  expect((await f.load())?.settlement.classification).toBe("Settled");
});
