import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  window: vi.fn(),
  capture: vi.fn(),
  ordinary: vi.fn(),
  compensation: vi.fn(),
  unmatched: vi.fn(),
}));
vi.mock("./pilot-settlement-window.mjs", () => ({
  createInternalClosedSettlementWindow: () => mocks.window,
}));
vi.mock("../../packages/rms/payment/src/index.ts", async (original) => ({
  ...(await original()),
  createPostgresPaymentCaptureWindowSource: () => mocks.capture,
  createPostgresOrdinaryRefundWindowSource: () => mocks.ordinary,
  createPostgresConfirmedCompensationRefundSource: () => mocks.compensation,
  createPostgresUnmatchedCaptureRefundStore: () => ({
    list: mocks.unmatched,
    providerRequest: (state) => ({ unmatched: state.reconciliationExceptionReference }),
  }),
}));
vi.mock("../../packages/rms/payment/src/application/ordinary-refund-provider-result.ts", () => ({
  bindOrdinaryRefundProviderOutcome: (_request, outcome) => outcome,
}));
import { createInternalDailySettlementSource } from "./pilot-daily-settlement-source.mjs";
const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const at = "2026-09-22T01:00:00.000Z",
    window = {
      businessDate: "2026-09-20",
      startsAt: "2026-09-20T08:00:00.000Z",
      endsAt: "2026-09-21T08:00:00.000Z",
    };
  const record = {
    receipt: {
      fact: {
        refundReference: id(5),
        amount: { amountMinor: 1250n, currencyCode: "CAD" },
        providerConfirmedAt: window.endsAt,
      },
    },
    action: { claimedAt: window.startsAt },
    request: {},
  };
  const outcome = {
    kind: "RefundObservation",
    status: "succeeded",
    amount: { amountMinor: 1250n, currencyCode: "CAD" },
    providerRefundReference: "re_SYNTHETIC",
    createdAt: window.startsAt,
    observedAt: at,
  };
  mocks.window.mockReset().mockResolvedValue(window);
  mocks.capture.mockReset().mockResolvedValue({ capturedAmountMinor: 0n, captureCount: 0 });
  mocks.ordinary
    .mockReset()
    .mockResolvedValue({ unresolvedOperationCount: 0, refundedAmountMinor: 100n, refundCount: 1 });
  mocks.compensation
    .mockReset()
    .mockResolvedValue({ records: [record], nextAfterRefundReference: null });
  mocks.unmatched.mockReset().mockResolvedValue({ states: [], nextAfterExceptionReference: null });
  const scope = { brandReference: id(1), storeReference: id(2) },
    active = vi.fn(async () => true);
  const simulator = {
    simulation: true,
    adapter: { lookupRefund: vi.fn(async () => outcome) },
    readSettlementWindow: vi.fn(async () => ({
      source: "InternalTestSimulator",
      ...scope,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      currencyCode: "CAD",
      observedAt: at,
      capturedAmountMinor: 0n,
      refundedAmountMinor: 1350n,
    })),
  };
  const r = {
    scope,
    publicProfile: { binding: { tenantReference: id(3) } },
    now: () => at,
    transactions: { run: async (work) => work({}) },
  };
  return {
    record,
    outcome,
    simulator,
    active,
    run: createInternalDailySettlementSource({
      resources: r,
      simulator,
      providerAccountReference: id(4),
      active,
    }),
  };
}
it("combines refund-only day and preserves independent Provider evidence", async () => {
  const f = fixture(),
    r = await f.run();
  expect(r.candidate.internalCapturedAmount.amountMinor).toBe(0n);
  expect(r.candidate.internalRefundedAmount.amountMinor).toBe(1350n);
  expect(r.candidate.providerRefundedAmount.amountMinor).toBe(1350n);
  expect(r.candidate.settlementReference).toContain(r.evidenceDigest.slice(7));
  expect((await f.run()).candidate.candidateReference).toBe(r.candidate.candidateReference);
});
it("retains a real difference rather than replacing internal totals", async () => {
  const f = fixture();
  mocks.capture.mockResolvedValue({ capturedAmountMinor: 1000n });
  const r = await f.run();
  expect(r.candidate.internalCapturedAmount.amountMinor).toBe(1000n);
  expect(r.candidate.providerCapturedAmount.amountMinor).toBe(0n);
});
it("does not count an end-boundary refund", async () => {
  const f = fixture();
  f.outcome.createdAt = "2026-09-21T08:00:00.000Z";
  expect((await f.run()).sources.compensation.refundCount).toBe(0);
});
it("rejects unresolved ordinary work before building a complete candidate", async () => {
  const f = fixture();
  mocks.ordinary.mockResolvedValue({ unresolvedOperationCount: 1 });
  await expect(f.run()).rejects.toThrow();
  expect(f.simulator.adapter.lookupRefund).not.toHaveBeenCalled();
});
it.each(["unknown", "amount", "created", "duplicate"])(
  "rejects unusable compensation evidence %s",
  async (kind) => {
    const f = fixture();
    if (kind === "unknown") f.outcome.status = "pending";
    if (kind === "amount") f.outcome.amount.amountMinor = 1200n;
    if (kind === "created") f.outcome.createdAt = "2026-09-19T00:00:00.000Z";
    if (kind === "duplicate")
      mocks.compensation.mockResolvedValue({
        records: [f.record, f.record],
        nextAfterRefundReference: null,
      });
    await expect(f.run()).rejects.toThrow();
  },
);
it("rejects wrong Provider scope and revoked installation", async () => {
  const f = fixture();
  f.simulator.readSettlementWindow.mockResolvedValue({
    source: "InternalTestSimulator",
    brandReference: id(90),
  });
  await expect(f.run()).rejects.toThrow();
  f.active.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
});

it("forwards the historical boundary without backdating evidence observation", async () => {
  const f = fixture(),
    cursor = { endingAt: "2026-09-21T08:00:00.000Z" },
    result = await f.run(cursor);
  expect(mocks.window).toHaveBeenCalledWith(cursor);
  expect(result.candidate.evidenceObservedAt).toBe("2026-09-22T01:00:00.000Z");
});

/** WP-2423 v15: a Provider charge matching no Order (Sep 20) refunded by staff on Oct 9. */
function unmatchedCharge(overrides = {}) {
  return {
    reconciliationExceptionReference: id(60),
    providerAccountReference: id(4),
    environment: "Test",
    providerTransactionReference: "ch_SYNTHETIC_UNMATCHED",
    amountMinor: "2260",
    capturedAt: "2026-09-10T12:00:00.000Z",
    status: "Refunded",
    outcome: {
      providerRefundReference: "re_SYNTHETIC_UNMATCHED",
      providerObservedAt: "2026-09-20T12:00:01.000Z",
      recordedAt: "2026-09-20T12:00:02.000Z",
    },
    ...overrides,
  };
}
it("counts the refund of an unmatched Provider charge on the day the Provider made it", async () => {
  const f = fixture();
  mocks.unmatched.mockResolvedValue({
    states: [unmatchedCharge()],
    nextAfterExceptionReference: null,
  });
  const refund = {
    ...f.outcome,
    amount: { amountMinor: 2260n, currencyCode: "CAD" },
    providerRefundReference: "re_SYNTHETIC_UNMATCHED",
    createdAt: "2026-09-20T12:00:00.000Z",
  };
  f.simulator.adapter.lookupRefund.mockImplementation(async (request) =>
    request.unmatched ? refund : f.outcome,
  );
  f.simulator.readSettlementWindow.mockResolvedValue({
    ...(await f.simulator.readSettlementWindow()),
    refundedAmountMinor: 1350n + 2260n,
  });
  const r = await f.run();
  // Before WP-2423 our side read 1350 against the Provider's 3610: a false refund difference.
  expect(r.candidate.internalRefundedAmount.amountMinor).toBe(3610n);
  expect(r.candidate.providerRefundedAmount.amountMinor).toBe(3610n);
  expect(r.candidate.internalCapturedAmount.amountMinor).toBe(0n);
  expect(r.sources.unmatched).toMatchObject({ refundCount: 1, captureCount: 0 });
});
it("counts an unmatched Provider charge on its capture day and its refund only on its own day", async () => {
  const f = fixture();
  mocks.unmatched.mockResolvedValue({
    states: [
      unmatchedCharge({
        capturedAt: "2026-09-20T09:00:00.000Z",
        status: "Unrefunded",
        outcome: null,
      }),
    ],
    nextAfterExceptionReference: null,
  });
  const r = await f.run();
  expect(r.candidate.internalCapturedAmount.amountMinor).toBe(2260n);
  expect(r.candidate.internalRefundedAmount.amountMinor).toBe(1350n);
});
it("refuses an unmatched refund the Provider does not confirm as recorded", async () => {
  const f = fixture();
  mocks.unmatched.mockResolvedValue({
    states: [unmatchedCharge()],
    nextAfterExceptionReference: null,
  });
  f.simulator.adapter.lookupRefund.mockImplementation(async (request) =>
    request.unmatched
      ? {
          ...f.outcome,
          amount: { amountMinor: 2260n, currencyCode: "CAD" },
          providerRefundReference: "re_OTHER",
        }
      : f.outcome,
  );
  await expect(f.run()).rejects.toThrow();
});
