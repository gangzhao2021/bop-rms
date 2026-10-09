import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createMerchantSettlementRead } from "./merchant-settlement-read.js";
const id = (n: number) => "0190ed90-0000-7000-8000-" + n.toString(16).padStart(12, "0");
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
    reconciliation: async () => ({ runs: [], differences: [] }),
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
    reconciliation: { runs: [], differences: [] },
    projectedAt: "2026-09-22T09:00:00.000Z",
  });
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(f.authorize.mock.calls[0]?.[1]).toEqual({
    sessionCookie: "cookie",
    permission: "operations.order-exception.manage",
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
