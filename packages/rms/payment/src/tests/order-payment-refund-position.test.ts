import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ordinary: vi.fn(), compensation: vi.fn() }));
vi.mock("../infrastructure/ordinary-refund-position-source.js", () => ({
  createPostgresOrdinaryRefundPositionSource: () => mocks.ordinary,
}));
vi.mock("../infrastructure/persistence/payment-compensation-refund-position-source.js", () => ({
  createPostgresPaymentCompensationRefundPositionSource: () => mocks.compensation,
}));
import { createPostgresOrderPaymentRefundPosition } from "../infrastructure/order-payment-refund-position.js";
const id = (n: number) => "0190fac2-0000-7000-8000-" + String(n).padStart(12, "0"),
  scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) };
const query = {
  orderReference: id(4),
  paymentTransactionReference: id(5),
  paymentIntentReference: id(6),
  paymentAttemptReference: id(7),
  observedAt: "2026-09-20T00:00:00.000Z",
};
const position = (confirmedMinor = 0n, pendingMinor = 0n) => ({
  confirmedMinor,
  pendingMinor,
  confirmedOrderAllocationMinor: confirmedMinor,
  confirmedTipMinor: 0n,
  unallocatedConfirmedMinor: 0n,
  version: 1,
  snapshotDigest: "sha256:" + "a".repeat(64),
});
const tx = { query: vi.fn() };
const source = (authorize = async () => true) =>
  createPostgresOrderPaymentRefundPosition({
    scope,
    providerAccountReference: id(8),
    environment: "Test",
    authorize,
  });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.ordinary.mockResolvedValue(position(10n, 20n));
  mocks.compensation.mockResolvedValue(position(30n, 40n));
});
it("preserves confirmed and pending amounts of both refund owners", async () => {
  const result = await source()(tx, query);
  expect(result).toMatchObject({ ...scope, ...query, confirmedMinor: 40n, pendingMinor: 60n });
  expect(mocks.compensation).toHaveBeenCalledWith(tx, {
    orderReference: query.orderReference,
    paymentTransactionReference: query.paymentTransactionReference,
    paymentAttemptReference: query.paymentAttemptReference,
  });
  expect(result).not.toHaveProperty("financialClass");
});
it("denies before loading history", async () => {
  await expect(source(async () => false)(tx, query)).rejects.toThrow();
  expect(mocks.ordinary).not.toHaveBeenCalled();
});
it("denies revoked authority after both sources", async () => {
  let calls = 0;
  await expect(source(async () => ++calls === 1)(tx, query)).rejects.toThrow();
});
it("bounds dependency errors", async () => {
  mocks.compensation.mockRejectedValue(new Error("PRIVATE"));
  await expect(source()(tx, query)).rejects.toThrow("ORDER_PAYMENT_REFUND_POSITION_UNAVAILABLE");
});
it.each([
  position(-1n),
  position(9223372036854775807n),
  { ...position(), version: 0 },
  { ...position(), snapshotDigest: "bad" },
])("rejects invalid or overflowing owner position %#", async (value) => {
  mocks.ordinary.mockResolvedValue(value);
  await expect(source()(tx, query)).rejects.toThrow();
});
it("rejects caller injected financial classification", async () => {
  await expect(
    source()(tx, { ...query, financialClass: "Settled" } as typeof query),
  ).rejects.toThrow();
  expect(mocks.ordinary).not.toHaveBeenCalled();
});

it("preserves exact ordinary tip allocation and keeps compensation unallocated", async () => {
  mocks.ordinary.mockResolvedValue({
    ...position(10n),
    confirmedOrderAllocationMinor: 7n,
    confirmedTipMinor: 3n,
  });
  expect(await source()(tx, query)).toMatchObject({
    confirmedMinor: 40n,
    confirmedOrderAllocationMinor: 7n,
    confirmedTipMinor: 3n,
    unallocatedConfirmedMinor: 30n,
    unallocatedCompensationMinor: 30n,
  });
});
it.each([
  { confirmedOrderAllocationMinor: 11n },
  { confirmedTipMinor: -1n },
  { unallocatedConfirmedMinor: 1n },
  { confirmedTipMinor: undefined },
])("rejects inconsistent allocation without silently inventing components %#", async (change) => {
  mocks.ordinary.mockResolvedValue({ ...position(10n), ...change });
  await expect(source()(tx, query)).rejects.toThrow("ORDER_PAYMENT_REFUND_POSITION_UNAVAILABLE");
});
