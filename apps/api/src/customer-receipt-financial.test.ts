import { expect, it, vi, beforeEach } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const d = vi.hoisted(() => ({ factory: vi.fn(), read: vi.fn() }));
vi.mock("@rms/payment", () => ({ createPostgresOrderFinancialPosition: d.factory }));
import { readCustomerReceiptFinancial } from "./customer-receipt-financial.js";
const id = (n: number) => `018f7a00-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const options = {
  scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
  providerAccountReference: id(4),
  environment: "Test" as const,
};
const input = { orderReference: id(5), observedAt: "2026-09-21T13:00:00.000Z" };
const position = {
  ...input,
  currencyCode: "CAD",
  capturedMinor: 1130n,
  confirmedRefundMinor: 0n,
  pendingRefundMinor: 600n,
  unresolvedAttemptCount: 0,
  captures: [{ paymentTransactionReference: id(6) }],
  snapshotDigest: "private",
};
beforeEach(() => {
  vi.resetAllMocks();
  d.factory.mockReturnValue(d.read);
  d.read.mockResolvedValue(position);
});
function fixture() {
  const query = vi.fn(async (sql: string) => {
    void sql;
    return { rows: [], rowCount: 0 };
  });
  return { tx: { query } as unknown as ConsumerTransaction, query, auth: vi.fn(async () => true) };
}
it("uses exact scoped owner query and exposes only customer financial facts", async () => {
  const f = fixture();
  expect(await readCustomerReceiptFinancial(f.tx, options, input, f.auth)).toEqual({
    observedAt: input.observedAt,
    currencyCode: "CAD",
    capturedMinor: 1130n,
    confirmedRefundMinor: 0n,
    pendingRefundMinor: 600n,
    unresolvedAttemptCount: 0,
  });
  expect(d.factory).toHaveBeenCalledWith({ ...options, authorize: expect.any(Function) });
  expect(d.read).toHaveBeenCalledWith(f.tx, input);
  const authorization = d.factory.mock.calls[0]?.[0].authorize;
  expect(await authorization(f.tx, { ...input, orderReference: id(90) })).toBe(false);
  expect(await authorization(f.tx, input)).toBe(true);
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    "SAVEPOINT customer_receipt_financial",
    "RELEASE SAVEPOINT customer_receipt_financial",
  ]);
});
it("recovers optional query failure without inventing zero amounts", async () => {
  const f = fixture();
  d.read.mockRejectedValue(new Error("synthetic private failure"));
  expect(await readCustomerReceiptFinancial(f.tx, options, input, f.auth)).toBeNull();
  expect(f.query.mock.calls.map(([sql]) => sql)).toEqual([
    "SAVEPOINT customer_receipt_financial",
    "ROLLBACK TO SAVEPOINT customer_receipt_financial",
    "RELEASE SAVEPOINT customer_receipt_financial",
  ]);
  expect(f.auth).toHaveBeenCalledTimes(2);
});
it.each([false, true])("denies lost authorization even after query failure=%s", async (failure) => {
  const f = fixture();
  f.auth.mockResolvedValueOnce(true).mockResolvedValue(false);
  if (failure) d.read.mockRejectedValue(new Error("unavailable"));
  await expect(readCustomerReceiptFinancial(f.tx, options, input, f.auth)).rejects.toMatchObject({
    code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
  });
});
it("never reads financial data without authorization", async () => {
  const f = fixture();
  f.auth.mockResolvedValue(false);
  await expect(readCustomerReceiptFinancial(f.tx, options, input, f.auth)).rejects.toMatchObject({
    code: "DIGITAL_RECEIPT_PERMISSION_DENIED",
  });
  expect(d.factory).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});
it("does not hide failed transaction recovery", async () => {
  const f = fixture();
  d.read.mockRejectedValue(new Error("unavailable"));
  f.query
    .mockResolvedValueOnce({ rows: [], rowCount: 0 })
    .mockRejectedValue(new Error("transaction failed"));
  await expect(readCustomerReceiptFinancial(f.tx, options, input, f.auth)).rejects.toThrow(
    "transaction failed",
  );
});
