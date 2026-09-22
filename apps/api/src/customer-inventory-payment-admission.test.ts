import { beforeEach, expect, it, vi } from "vitest";
import { parsePaymentIntentCreationRecord } from "@rms/payment";
import {
  parseSubmissionInventoryFinalValidation,
  advanceInventoryReservation,
  type SubmissionExpiryCutoff,
} from "@rms/inventory";
import { finalValidationFixture } from "../../../packages/rms/inventory/src/tests/submission-final-validation.fixture.js";
import { createCustomerInventoryPaymentClaimAdmission } from "./customer-inventory-payment-admission.js";
const mocks = vi.hoisted(() => ({ withCurrent: vi.fn(), factory: vi.fn() }));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresSubmissionFinalValidationStore: mocks.factory,
}));
beforeEach(() => vi.resetAllMocks());
function fixture(resolveExpiryCutoff?: SubmissionExpiryCutoff) {
  const record = parseSubmissionInventoryFinalValidation(finalValidationFixture());
  const at = record.observedAt;
  const id = (n: number) => "01909993-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
  const payment = parsePaymentIntentCreationRecord({
    intent: {
      paymentIntentReference: id(1),
      paymentOperationReference: id(2),
      intentDigest: "sha256:" + "a".repeat(64),
      preparation: {
        preparationReference: id(3),
        orderReference: record.orderReference,
        orderBatchReference: id(4),
        submissionReference: record.submissionReference,
        sourceCartReference: record.cartReference,
        sourceCartVersion: record.cartVersion,
        brandReference: record.brandReference,
        storeReference: record.storeReference,
        guestSessionReference: record.actorReference,
        quoteReference: record.quoteReference,
        capacityAllocationReference: id(5),
        readiness: "PaymentPending",
        transactionBoundary: "OrderSubmissionPaymentPreparation",
        orderAllocation: money(100n),
        tip: money(0n),
        total: money(100n),
        committedAt: at,
        capacityExpiresAt: new Date(Date.parse(at) + 1800000).toISOString(),
        sourceDigest: "sha256:" + "b".repeat(64),
      },
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
      aggregateVersion: 1,
      creationStatus: "ProviderCreatePending",
      createdAt: at,
    },
    attempt: {
      paymentAttemptReference: id(6),
      paymentIntentReference: id(1),
      attemptNumber: 1,
      provider: "Stripe",
      providerEnvironment: "Test",
      providerIdempotencyDigest: "sha256:" + "c".repeat(64),
      createdAt: at,
    },
    providerOutcome: null,
  });
  const tx = { query: vi.fn() };
  const facts = {
    record,
    observedAt: at,
    items: [],
    reservations: [...(record.reservationSet?.entries ?? [])],
    accounts: (record.reservationSet?.entries ?? []).map((entry) => ({
      accountReference: entry.accountReference,
      holdStatus: "Available",
      expiryDate: null as string | null,
    })),
  };
  const evaluate = vi.fn().mockResolvedValue(true);
  mocks.factory.mockReturnValue({ withCurrent: mocks.withCurrent });
  mocks.withCurrent.mockImplementation(async (_input, work) => work(tx, facts));
  const admission = createCustomerInventoryPaymentClaimAdmission({
    scope: {
      tenantReference: record.tenantReference,
      brandReference: record.brandReference,
      storeReference: record.storeReference,
    },
    authorize: vi.fn().mockResolvedValue(true),
    evaluate,
    ...(resolveExpiryCutoff ? { resolveExpiryCutoff } : {}),
  });
  const firstAccount = facts.accounts[0];
  const firstReservation = facts.reservations[0];
  if (!firstAccount || !firstReservation) throw new Error("synthetic fixture missing reservation");
  return {
    payment,
    tx,
    at,
    record,
    facts,
    evaluate,
    admission,
    id,
    firstAccount,
    firstReservation,
  };
}
it("passes the supplied transaction and exact owner facts to the required evaluator", async () => {
  const f = fixture();
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(true);
  expect(f.evaluate).toHaveBeenCalledWith(f.tx, { payment: f.payment, inventory: f.facts });
  const runner = mocks.factory.mock.calls.at(0)?.[0];
  expect(await runner.run(async (tx: unknown) => tx)).toBe(f.tx);
  expect(mocks.withCurrent).toHaveBeenCalledWith(
    {
      submissionReference: f.record.submissionReference,
      actorReference: f.record.actorReference,
      observedAt: f.at,
    },
    expect.any(Function),
  );
});
it.each(["orderReference", "cartReference", "quoteReference", "cartVersion"] as const)(
  "rejects mismatched %s before evaluating policy",
  async (field) => {
    const f = fixture();
    f.facts.record = {
      ...f.record,
      [field]: field === "cartVersion" ? f.record.cartVersion + 1 : f.id(99),
    };
    expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
    expect(f.evaluate).not.toHaveBeenCalled();
  },
);
it("rejects missing owner evidence and owner authorization failures", async () => {
  const f = fixture();
  mocks.withCurrent
    .mockResolvedValueOnce(null)
    .mockRejectedValueOnce(new Error("synthetic denied"));
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
  expect(f.evaluate).not.toHaveBeenCalled();
});
it("requires an explicit true policy result", async () => {
  const f = fixture();
  f.evaluate.mockResolvedValueOnce(false).mockResolvedValueOnce(undefined);
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
});

it.each(["Quarantined", "missing", "noResolver"])(
  "denies %s remaining stock before policy",
  async (kind) => {
    const f = fixture();
    if (kind === "Quarantined") f.firstAccount.holdStatus = "Quarantined";
    if (kind === "missing") f.facts.accounts.shift();
    if (kind === "noResolver") f.firstAccount.expiryDate = "2026-09-11";
    expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
    expect(f.evaluate).not.toHaveBeenCalled();
  },
);
it.each([
  ["2026-09-11T09:59:59.999Z", false],
  ["2026-09-11T10:00:00.000Z", false],
  ["2026-09-11T10:00:00.001Z", true],
  ["invalid", false],
] as const)("compares explicit cutoff %s at Payment time", async (cutoff, accepted) => {
  const resolve = vi.fn().mockResolvedValue(cutoff);
  const f = fixture(resolve);
  f.firstAccount.expiryDate = "2026-09-11";
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toEqual(
    accepted ? { validUntil: cutoff } : false,
  );
  expect(resolve).toHaveBeenCalledWith(f.tx, {
    storeReference: f.record.storeReference,
    accountReference: f.firstAccount.accountReference,
    expiryDate: "2026-09-11",
    observedAt: f.at,
  });
  expect(f.evaluate).toHaveBeenCalledTimes(accepted ? 1 : 0);
});
it("denies unavailable expiry authority without calling timing policy", async () => {
  const f = fixture(vi.fn().mockRejectedValue(new Error("synthetic unavailable")));
  f.firstAccount.expiryDate = "2026-09-11";
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
  expect(f.evaluate).not.toHaveBeenCalled();
});
it("leaves fully released stock to explicit timing policy without reinterpreting its expiry", async () => {
  const resolve = vi.fn();
  const f = fixture(resolve);
  const entry = f.firstReservation;
  f.facts.reservations[0] = {
    ...entry,
    reservation: advanceInventoryReservation(entry.reservation, {
      reservationReference: entry.reservation.reservationReference,
      binding: entry.reservation.binding,
      expectedVersion: entry.reservation.version,
      action: "Release",
      quantity: entry.reservation.originalQuantity,
      occurredAt: f.at,
    }),
  };
  f.firstAccount.expiryDate = "2026-09-11";
  f.evaluate.mockResolvedValue(false);
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toBe(false);
  expect(resolve).not.toHaveBeenCalled();
  expect(f.evaluate).toHaveBeenCalledOnce();
});

it("returns the earliest remaining lot deadline without losing timing denial", async () => {
  const resolve = vi
    .fn()
    .mockResolvedValueOnce("2026-09-11T10:02:00.000Z")
    .mockResolvedValueOnce("2026-09-11T10:01:00.000Z");
  const f = fixture(resolve);
  for (const account of f.facts.accounts) account.expiryDate = "2026-09-11";
  expect(await f.admission.admit(f.tx, f.payment, f.at)).toEqual({
    validUntil: "2026-09-11T10:01:00.000Z",
  });
});
