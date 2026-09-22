import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ load: vi.fn(), refund: vi.fn() }));
vi.mock("../infrastructure/persistence/order-payment-attempt-position.js", () => ({
  createPostgresOrderPaymentAttemptPosition: () => ({ load: mock.load }),
}));
vi.mock("../infrastructure/order-payment-refund-position.js", () => ({
  createPostgresOrderPaymentRefundPosition: () => mock.refund,
}));
import { createPostgresOrderFinancialPosition } from "../infrastructure/order-financial-position.js";
const id = (n: number) => "0190fae5-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
  query = { orderReference: id(4), observedAt: at };
const attempts = [
  {
    paymentIntentReference: id(10),
    paymentAttemptReference: id(11),
    orderBatchReference: id(12),
    terminalReference: id(13),
    outcome: "Succeeded",
    totalMinor: "1130",
    orderAllocationMinor: "1030",
    tipMinor: "100",
  },
  {
    paymentIntentReference: id(20),
    paymentAttemptReference: id(21),
    orderBatchReference: id(22),
    terminalReference: id(23),
    outcome: "Succeeded",
    totalMinor: "2260",
    orderAllocationMinor: "2260",
    tipMinor: "0",
  },
];
const position = () => ({
  ...scope,
  ...query,
  providerAccountReference: id(5),
  environment: "Test",
  attempts,
  capturedMinor: 3390n,
  unresolvedCount: 1,
  failedCount: 0,
  snapshotDigest: hash,
});
beforeEach(() => {
  mock.load.mockReset().mockResolvedValue(position());
  mock.refund.mockReset().mockResolvedValue({
    confirmedMinor: 100n,
    pendingMinor: 50n,
    confirmedOrderAllocationMinor: 100n,
    confirmedTipMinor: 0n,
    unallocatedConfirmedMinor: 0n,
    unallocatedCompensationMinor: 0n,
    snapshotDigest: hash,
  });
});
function setup() {
  const authorize = vi.fn(async () => true),
    tx = { query: vi.fn() },
    read = createPostgresOrderFinancialPosition({
      scope,
      providerAccountReference: id(5),
      environment: "Test",
      authorize,
    });
  return { authorize, tx, read: () => read(tx, query) };
}
it("combines all captures and both-owner refund positions without losing pending facts", async () => {
  const f = setup(),
    result = await f.read();
  expect(result.capturedMinor).toBe(3390n);
  expect(result.capturedOrderAllocationMinor).toBe(3290n);
  expect(result.capturedTipMinor).toBe(100n);
  expect(result.confirmedRefundMinor).toBe(200n);
  expect(result.pendingRefundMinor).toBe(100n);
  expect(result.netCapturedMinor).toBe(3190n);
  expect(result.unresolvedAttemptCount).toBe(1);
  expect(mock.refund).toHaveBeenCalledTimes(2);
  expect(mock.refund.mock.calls[0]?.[0]).toBe(f.tx);
  expect(mock.refund.mock.calls[1]?.[1]).toMatchObject({
    paymentTransactionReference: id(23),
    paymentIntentReference: id(20),
  });
  expect(Object.isFrozen(result.captures)).toBe(true);
  expect(result).not.toHaveProperty("financialClass");
});
it("does not query refunds for failed or unresolved attempts", async () => {
  mock.load.mockResolvedValue({
    ...position(),
    attempts: [{ ...attempts[0], outcome: "Unresolved", terminalReference: null }],
    capturedMinor: 0n,
  });
  const result = await setup().read();
  expect(result.capturedMinor).toBe(0n);
  expect(mock.refund).not.toHaveBeenCalled();
});
it.each([
  { confirmedMinor: 1131n, pendingMinor: 0n },
  { confirmedMinor: 1000n, pendingMinor: 131n },
  { confirmedMinor: -1n, pendingMinor: 0n },
])("rejects over-refund or malformed owner totals case %#", async (amounts) => {
  mock.refund.mockResolvedValue({ ...amounts, snapshotDigest: hash });
  await expect(setup().read()).rejects.toThrow("ORDER_FINANCIAL_POSITION_UNAVAILABLE");
});
it("rejects scope drift and mismatched capture totals", async () => {
  mock.load.mockResolvedValue({ ...position(), storeReference: id(99) });
  await expect(setup().read()).rejects.toThrow();
  mock.load.mockResolvedValue({ ...position(), capturedMinor: 4000n });
  await expect(setup().read()).rejects.toThrow();
});
it("propagates unavailable refund evidence as unavailable, never zero", async () => {
  mock.refund.mockRejectedValue(new Error("private"));
  await expect(setup().read()).rejects.toThrow("ORDER_FINANCIAL_POSITION_UNAVAILABLE");
});
it("denies before reads and after revocation", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow();
  expect(mock.load).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.read()).rejects.toThrow();
});

it("aggregates bound allocations while preserving separate capture totals", async () => {
  const result = await setup().read();
  expect(result.refundAllocation).toEqual({ orderMinor: 200n, tipMinor: 0n, unallocatedMinor: 0n });
  expect(result.capturedMinor).toBe(3390n);
});
it("rejects refund tip allocations exceeding that payment even when another capture has tips", async () => {
  mock.refund.mockResolvedValue({
    confirmedMinor: 100n,
    pendingMinor: 0n,
    confirmedOrderAllocationMinor: 0n,
    confirmedTipMinor: 100n,
    unallocatedConfirmedMinor: 0n,
    unallocatedCompensationMinor: 0n,
    snapshotDigest: hash,
  });
  await expect(setup().read()).rejects.toThrow();
});

function fullCompensation(confirmedMinor = 1130n, unallocatedCompensationMinor = 1130n) {
  mock.load.mockResolvedValue({ ...position(), attempts: [attempts[0]], capturedMinor: 1130n });
  mock.refund.mockResolvedValue({
    confirmedMinor,
    pendingMinor: 0n,
    confirmedOrderAllocationMinor: 0n,
    confirmedTipMinor: 0n,
    unallocatedConfirmedMinor: confirmedMinor,
    unallocatedCompensationMinor,
    snapshotDigest: hash,
  });
}
it("derives full confirmed compensation components only from its exact original capture", async () => {
  fullCompensation();
  const result = await setup().read();
  expect(result.refundAllocation).toEqual({
    orderMinor: 1030n,
    tipMinor: 100n,
    unallocatedMinor: 0n,
  });
  expect(result.capturedMinor).toBe(1130n);
  expect(result.confirmedRefundMinor).toBe(1130n);
  expect(result.netCapturedMinor).toBe(0n);
});
it("completes only residual compensation after fully bound ordinary refund components", async () => {
  fullCompensation();
  mock.refund.mockResolvedValue({
    confirmedMinor: 1130n,
    pendingMinor: 0n,
    confirmedOrderAllocationMinor: 200n,
    confirmedTipMinor: 50n,
    unallocatedConfirmedMinor: 880n,
    unallocatedCompensationMinor: 880n,
    snapshotDigest: hash,
  });
  expect((await setup().read()).refundAllocation).toEqual({
    orderMinor: 1030n,
    tipMinor: 100n,
    unallocatedMinor: 0n,
  });
});
it("keeps partial compensation and unproven ordinary allocation unresolved", async () => {
  fullCompensation(500n, 500n);
  expect((await setup().read()).refundAllocation.unallocatedMinor).toBe(500n);
  fullCompensation(1130n, 1000n);
  expect((await setup().read()).refundAllocation.unallocatedMinor).toBe(1130n);
});
it("rejects compensation provenance exceeding the unallocated total", async () => {
  fullCompensation(500n, 600n);
  await expect(setup().read()).rejects.toThrow();
});
