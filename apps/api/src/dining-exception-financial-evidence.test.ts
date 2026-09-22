import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const d = vi.hoisted(() => ({
  closure: vi.fn(),
  priced: vi.fn(),
  financial: vi.fn(),
  finality: vi.fn(),
  store: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresOrderClosurePosition: () => d.closure,
  createPostgresOrderPricedAmountSource: () => d.priced,
}));
vi.mock("@rms/payment", async (original) => ({
  ...(await original<typeof import("@rms/payment")>()),
  createPostgresOrderFinancialPosition: () => d.financial,
  createPostgresOrderSettledFinalityStore: d.store,
}));
import { createDiningExceptionFinancialEvidence } from "./dining-exception-financial-evidence.js";
const id = (n: number) => "0190fa85-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-21T01:00:00.000Z",
  old = "2026-09-21T00:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
beforeEach(() => {
  vi.resetAllMocks();
  d.store.mockReturnValue({ readFinality: d.finality });
});
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    query = { orderReference: id(4), observedAt: at },
    base = { ...scope, ...query },
    authorize = vi.fn(async () => true),
    closure = {
      ...base,
      orderVersion: 2,
      orderCheckpoint: id(5),
      status: "Closed",
      financialFinalityReference: id(6),
    },
    priced = { ...base, pricedTotalMinor: 100n, pendingAmendmentCount: 0 },
    financial = {
      ...base,
      providerAccountReference: id(7),
      environment: "Test",
      currencyCode: "CAD",
      capturedMinor: 120n,
      capturedOrderAllocationMinor: 100n,
      capturedTipMinor: 20n,
      confirmedRefundMinor: 0n,
      pendingRefundMinor: 0n,
      unresolvedAttemptCount: 0,
    };
  const fact = {
    ...scope,
    orderReference: id(4),
    orderVersion: 2,
    orderCheckpoint: id(5),
    finalityReference: id(6),
    operationReference: id(8),
    providerAccountReference: id(7),
    environment: "Test",
    classification: "Settled",
    currencyCode: "CAD",
    pricedOrderTotalMinor: "100",
    capturedMinor: "120",
    capturedOrderAllocationMinor: "100",
    capturedTipMinor: "20",
    orderEvidenceDigest: digest,
    paymentEvidenceDigest: digest,
    decidedAt: old,
  };
  d.closure.mockResolvedValue(closure);
  d.priced.mockResolvedValue(priced);
  d.financial.mockResolvedValue(financial);
  d.finality.mockResolvedValue(fact);
  const tx = { query: vi.fn() } as ConsumerTransaction,
    read = createDiningExceptionFinancialEvidence({
      scope,
      providerAccountReference: id(7),
      environment: "Test",
      authorize,
    });
  return { closure, priced, financial, fact, authorize, tx, query, run: () => read(tx, query) };
}
it("uses matching committed owner finality and preserves its original time", async () => {
  const f = setup();
  expect(await f.run()).toMatchObject({
    orderVersion: 2,
    financial: {
      financialClass: "Settled",
      ownerFinalityReference: id(6),
      ownerDecidedAt: old,
      observedAt: at,
    },
  });
  expect(d.finality).toHaveBeenCalledWith(f.tx, {
    ...f.query,
    finalityReference: id(6),
    expectedOrderVersion: 2,
  });
  const storeOptions = d.store.mock.calls[0]?.[0];
  if (!storeOptions) throw new Error("missing synthetic store options");
  await expect(storeOptions.audit()).rejects.toThrow();
});
it("keeps numerically settled but unclosed orders Unknown", async () => {
  const f = setup();
  f.closure.status = "Open";
  expect((await f.run()).financial).toBeNull();
  expect(d.finality).not.toHaveBeenCalled();
});
it("does not clear unpaid, pending or refunded positions using historical finality", async () => {
  const f = setup();
  f.priced.pricedTotalMinor = 200n;
  expect((await f.run()).financial?.financialClass).toBe("Unpaid");
  f.priced.pricedTotalMinor = 100n;
  f.financial.pendingRefundMinor = 10n;
  expect((await f.run()).financial).toMatchObject({
    financialClass: "Indeterminate",
    ownerFinalityReference: null,
  });
  f.financial.pendingRefundMinor = 0n;
  f.financial.confirmedRefundMinor = 10n;
  expect((await f.run()).financial?.financialClass).toBe("Indeterminate");
  expect(d.finality).not.toHaveBeenCalled();
});
it("refuses wrong scope, stale/future finality and amount mismatch", async () => {
  for (const change of [
    { storeReference: id(99) },
    { orderVersion: 1 },
    { orderCheckpoint: id(99) },
    { decidedAt: "2026-09-22T00:00:00.000Z" },
    { capturedMinor: "130", capturedTipMinor: "30" },
  ]) {
    const f = setup();
    Object.assign(f.fact, change);
    await expect(f.run()).rejects.toThrow();
  }
});
it("refuses missing finality and revoked authorization", async () => {
  const f = setup();
  d.finality.mockResolvedValueOnce(null);
  await expect(f.run()).rejects.toThrow();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.run()).rejects.toThrow();
  f.authorize.mockResolvedValue(false);
  d.closure.mockClear();
  await expect(f.run()).rejects.toThrow();
  expect(d.closure).not.toHaveBeenCalled();
});
