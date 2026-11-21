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
    "MERCHANT_SETTLEMENT_DENIED",
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
it("WP-2423 M160: the business-day owner's 'before the records begin' answers with the first day", async () => {
  const tx = { query: vi.fn() } as ConsumerTransaction;
  const authorize = vi.fn(async () => scope);
  const before = Object.assign(new Error("MERCHANT_BUSINESS_DAY_BEFORE_RECORDS"), {
    code: "MERCHANT_BUSINESS_DAY_BEFORE_RECORDS",
    firstBusinessDate: "2026-11-04",
  });
  const captured = vi.fn(async () => null);
  const read = createMerchantSettlementRead({
    transactions: { run: async (work) => work(tx) },
    authorize,
    storeLabel: async () => "Synthetic Store",
    window: vi.fn(async () => {
      throw before;
    }),
    captured,
    refunded: async () => null,
    reconciliation: async () => emptyDay,
    now: () => "2026-11-06T09:00:00.000Z",
  });
  await expect(read({ sessionCookie: "c", businessDate: "2026-11-03" })).rejects.toMatchObject({
    code: "MERCHANT_SETTLEMENT_NOT_COVERED",
    firstBusinessDate: "2026-11-04",
  });
  expect(captured).not.toHaveBeenCalled();
  expect(authorize).toHaveBeenCalledTimes(2);
  // A changed scope is refused, not answered; any other window failure stays a failure.
  authorize.mockResolvedValueOnce(scope).mockResolvedValueOnce({ ...scope, storeReference: id(9) });
  await expect(read({ sessionCookie: "c", businessDate: null })).rejects.toThrow(
    "MERCHANT_SETTLEMENT_UNAVAILABLE",
  );
  const down = createMerchantSettlementRead({
    transactions: { run: async (work) => work(tx) },
    authorize,
    storeLabel: async () => "Synthetic Store",
    window: vi.fn(async () => {
      throw Object.assign(new Error("X"), { code: "MERCHANT_BUSINESS_DAY_BEFORE_RECORDS" });
    }),
    captured,
    refunded: async () => null,
    reconciliation: async () => emptyDay,
    now: () => "2026-11-06T09:00:00.000Z",
  });
  await expect(down({ sessionCookie: "c", businessDate: null })).rejects.toThrow("X");
});

// WP-2423 (settlement-coverage): whether a closed day's check has run is decided on server time,
// and the page is told BOP knows only when the alert really reaches BOP's channels.
it("a closed day with no settlement run is Waiting for 6 h, then NotRun, and BOP told only when alerted", async () => {
  const at = (now: string, alerted?: () => Promise<boolean>) =>
    createMerchantSettlementRead({
      transactions: { run: async (work) => work({ query: vi.fn() } as ConsumerTransaction) },
      authorize: async () => scope,
      storeLabel: async () => "Synthetic Store",
      window: async () => window,
      captured: async () => null,
      refunded: async () => null,
      reconciliation: async () => emptyDay,
      now: () => now,
      ...(alerted === undefined ? {} : { dayEndCheckAlerted: alerted }),
    })({ sessionCookie: "c", businessDate: null });
  // Closed at 08:00Z.
  expect((await at("2026-09-22T09:00:00.000Z")).dayEndCheck).toEqual({
    state: "Waiting",
    closedForMs: 3600_000,
    supportAlerted: false,
  });
  expect((await at("2026-09-22T21:00:00.000Z")).dayEndCheck).toEqual({
    state: "NotRun",
    closedForMs: 13 * 3600_000,
    supportAlerted: false,
  });
  expect((await at("2026-09-22T21:00:00.000Z", async () => true)).dayEndCheck).toMatchObject({
    state: "NotRun",
    supportAlerted: true,
  });
  // A board that cannot be read is never "BOP has been told".
  expect(
    (
      await at("2026-09-22T21:00:00.000Z", async () => {
        throw Error("ENOENT");
      })
    ).dayEndCheck,
  ).toMatchObject({ state: "NotRun", supportAlerted: false });
});
it("a day already checked, an open day or unread records carry no day-end check line", async () => {
  const read = (overrides: Partial<Parameters<typeof createMerchantSettlementRead>[0]>) =>
    createMerchantSettlementRead({
      transactions: { run: async (work) => work({ query: vi.fn() } as ConsumerTransaction) },
      authorize: async () => scope,
      storeLabel: async () => "Synthetic Store",
      window: async () => window,
      captured: async () => null,
      refunded: async () => null,
      reconciliation: async () => emptyDay,
      now: () => "2026-09-22T21:00:00.000Z",
      dayEndCheckAlerted: async () => true,
      ...overrides,
    })({ sessionCookie: "c", businessDate: null });
  expect((await read({ reconciliation: async () => null })).dayEndCheck).toBeNull();
  expect(
    (await read({ window: async () => ({ ...window, status: "Open" as const }) })).dayEndCheck,
  ).toBeNull();
  const settled = {
    ...emptyDay,
    settlement: { run: {}, checks: [], recheck: null },
  } as unknown as typeof emptyDay;
  expect((await read({ reconciliation: async () => settled })).dayEndCheck).toBeNull();
});
it("waits as long as the operations monitor before a day counts as not run", async () => {
  const { merchantSettlementNotRunAfterMs } = await import("./merchant-settlement-read.js");
  const { SETTLEMENT_MISSING_GRACE_MS } = (await import(
    /* @vite-ignore */ new URL(
      "../../../tooling/environment/pilot-ops-observe.mjs",
      import.meta.url,
    ).href
  )) as { SETTLEMENT_MISSING_GRACE_MS: number };
  expect(merchantSettlementNotRunAfterMs).toBe(SETTLEMENT_MISSING_GRACE_MS);
});
// WP-2423 (settlement-coverage): a real Pilot Store's day-end checks start at its issued record;
// a closed day before that is never compared, so it is never "runs by itself once it is fixed".
it("a closed day before the Store's day-end checks start is NotCovered, never NotRun", async () => {
  const read = (coveredFrom: () => Promise<string | null>) =>
    createMerchantSettlementRead({
      transactions: { run: async (work) => work({ query: vi.fn() } as ConsumerTransaction) },
      authorize: async () => scope,
      storeLabel: async () => "Synthetic Store",
      window: async () => window,
      captured: async () => null,
      refunded: async () => null,
      reconciliation: async () => emptyDay,
      now: () => "2026-09-22T21:00:00.000Z",
      dayEndCheckAlerted: async () => true,
      dayEndCheckCoveredFrom: coveredFrom,
    })({ sessionCookie: "c", businessDate: null });
  // Checks start with the next day: this day is outside coverage.
  expect((await read(async () => "2026-09-22T08:00:00.000Z")).dayEndCheck).toEqual({
    state: "NotCovered",
    closedForMs: 13 * 3600_000,
    supportAlerted: false,
  });
  // Checks start with this day (or with the Store's first day): an ordinary not-run day.
  expect((await read(async () => "2026-09-21T08:00:00.000Z")).dayEndCheck).toMatchObject({
    state: "NotRun",
    supportAlerted: true,
  });
  expect((await read(async () => null)).dayEndCheck).toMatchObject({ state: "NotRun" });
  // Where checks start cannot be read: no claim either way.
  expect(
    (
      await read(async () => {
        throw Error("ENOENT");
      })
    ).dayEndCheck,
  ).toBeNull();
});
