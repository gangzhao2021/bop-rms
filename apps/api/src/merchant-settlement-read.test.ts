import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantSettlementRead } from "./merchant-settlement-read.js";
const id = (n: number) => "0190ed90-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const emptyDay = {
  settlement: null,
  operational: {
    runCount: 0,
    latestRun: null,
    paymentCount: 0,
    outcomes: { Matched: 0, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
  },
  differences: [],
  differenceCount: 0,
};
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  sessionReference: id(4),
};
const window = {
  businessDate: "2026-09-21",
  startsAt: "2026-09-21T08:00:00.000Z",
  endsAt: "2026-09-22T08:00:00.000Z",
  timeZone: "America/Toronto",
  status: "Closed" as const,
};
function fixture() {
  const tx = { query: vi.fn() } as ConsumerTransaction;
  const authorize = vi.fn<
    (
      tx: ConsumerTransaction,
      input: { sessionCookie: unknown; permission: string },
    ) => Promise<typeof scope | null>
  >(async () => scope);
  const read = createMerchantSettlementRead({
    transactions: { run: async (work) => work(tx) },
    authorize,
    storeLabel: async () => "Synthetic Store",
    window: vi.fn(async (_tx, _scope, businessDate) => ({
      ...window,
      businessDate: businessDate ?? window.businessDate,
    })),
    captured: async () => ({ count: 14, amountMinor: "123450", currencyCode: "CAD" }),
    refunded: async () => null,
    reconciliation: async () => emptyDay,
    now: () => "2026-09-22T09:00:00.000Z",
  });
  return { read, authorize };
}
it("returns the day-end view with each owner answer and a re-checked scope", async () => {
  const f = fixture();
  const view = await f.read({ sessionCookie: "cookie", businessDate: null });
  expect(view).toMatchObject({
    screenId: "PAY-RECONCILIATION",
    storeLabel: "Synthetic Store",
    businessDate: "2026-09-21",
    window: { status: "Closed", timeZone: "America/Toronto" },
    captured: { count: 14, amountMinor: "123450" },
    refunded: null,
    reconciliation: emptyDay,
    projectedAt: "2026-09-22T09:00:00.000Z",
  });
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize.mock.calls[0]?.[1]).toEqual({
    sessionCookie: "cookie",
    permission: "payment.settlement.read",
  });
});
it("rejects a malformed date, a different day than requested and a changed scope", async () => {
  const malformed = fixture();
  await expect(malformed.read({ sessionCookie: "c", businessDate: "2026-9-1" })).rejects.toThrow(
    "MERCHANT_SETTLEMENT_UNAVAILABLE",
  );
  const switched = fixture();
  switched.authorize
    .mockResolvedValueOnce(scope)
    .mockResolvedValue({ ...scope, storeReference: id(9) });
  await expect(switched.read({ sessionCookie: "c", businessDate: "2026-09-21" })).rejects.toThrow(
    "MERCHANT_SETTLEMENT_UNAVAILABLE",
  );
  const denied = fixture();
  denied.authorize.mockResolvedValue(null);
  await expect(denied.read({ sessionCookie: "c", businessDate: null })).rejects.toThrow(
    "MERCHANT_SETTLEMENT_UNAVAILABLE",
  );
});
it("WP-2423 Q19: shows the day's self-approved refunds, or null when not composed", async () => {
  const tx = { query: vi.fn() } as ConsumerTransaction;
  const selfApproved = vi.fn(async () => ({
    count: 2,
    amountMinor: "23200",
    currencyCode: "CAD" as const,
  }));
  const options = {
    transactions: { run: async <T>(work: (t: ConsumerTransaction) => Promise<T>) => work(tx) },
    authorize: async () => scope,
    storeLabel: async () => "Synthetic Store",
    window: async () => window,
    captured: async () => null,
    refunded: async () => null,
    reconciliation: async () => null,
    now: () => "2026-09-22T09:00:00.000Z",
  };
  const view = await createMerchantSettlementRead({
    ...options,
    selfApprovedRefunds: selfApproved,
  })({ sessionCookie: "c", businessDate: null });
  expect(view.selfApprovedRefunds).toEqual({ count: 2, amountMinor: "23200", currencyCode: "CAD" });
  expect(selfApproved).toHaveBeenCalledWith(tx, scope, window);
  const absent = await createMerchantSettlementRead(options)({
    sessionCookie: "c",
    businessDate: null,
  });
  expect(absent.selfApprovedRefunds).toBeNull();
});

it("WP-2423 Q19: beside a closed day, shows the current day's self-approved refunds so far", async () => {
  const tx = { query: vi.fn() } as ConsumerTransaction;
  const today = vi.fn(async () => ({
    businessDate: "2026-09-22",
    count: 1,
    amountMinor: "11600",
    currencyCode: "CAD" as const,
  }));
  const options = {
    transactions: { run: async <T>(work: (t: ConsumerTransaction) => Promise<T>) => work(tx) },
    authorize: async () => scope,
    storeLabel: async () => "Synthetic Store",
    captured: async () => null,
    refunded: async () => null,
    reconciliation: async () => null,
    currentDaySelfApprovedRefunds: today,
    now: () => "2026-09-22T09:00:00.000Z",
  };
  const closed = await createMerchantSettlementRead({ ...options, window: async () => window })({
    sessionCookie: "c",
    businessDate: null,
  });
  expect(closed.currentDaySelfApprovedRefunds).toMatchObject({
    businessDate: "2026-09-22",
    count: 1,
  });
  const open = await createMerchantSettlementRead({
    ...options,
    window: async () => ({ ...window, status: "Open" as const }),
  })({ sessionCookie: "c", businessDate: "2026-09-21" });
  expect(open.currentDaySelfApprovedRefunds).toBeNull();
  expect(today).toHaveBeenCalledTimes(1);
});
it("WP-2423: a day before the Store's records begin answers with the first day, after re-checking scope", async () => {
  const tx = { query: vi.fn() } as ConsumerTransaction;
  const authorize = vi.fn(async () => scope);
  const windowRead = vi.fn(async () => window);
  const read = createMerchantSettlementRead({
    transactions: { run: async (work) => work(tx) },
    authorize,
    storeLabel: async () => "Synthetic Store",
    window: windowRead,
    captured: async () => null,
    refunded: async () => null,
    reconciliation: async () => emptyDay,
    firstBusinessDate: async () => "2026-09-20",
    now: () => "2026-09-22T09:00:00.000Z",
  });
  await expect(read({ sessionCookie: "c", businessDate: "2026-09-19" })).rejects.toMatchObject({
    code: "MERCHANT_SETTLEMENT_NOT_COVERED",
    firstBusinessDate: "2026-09-20",
  });
  expect(windowRead).not.toHaveBeenCalled();
  expect(authorize).toHaveBeenCalledTimes(2);
  // The first covered day and the latest closed day read normally.
  await expect(read({ sessionCookie: "c", businessDate: "2026-09-21" })).resolves.toMatchObject({
    businessDate: "2026-09-21",
  });
  await expect(read({ sessionCookie: "c", businessDate: null })).resolves.toBeTruthy();
  // A changed scope is still refused, not answered.
  authorize.mockResolvedValueOnce(scope).mockResolvedValueOnce({ ...scope, storeReference: id(9) });
  await expect(read({ sessionCookie: "c", businessDate: "2026-09-19" })).rejects.toThrow(
    "MERCHANT_SETTLEMENT_UNAVAILABLE",
  );
});
