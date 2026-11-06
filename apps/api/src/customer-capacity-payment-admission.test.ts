import { beforeEach, expect, it, vi } from "vitest";
import { DiningCheckoutCommitmentError, DiningCheckoutStoreError } from "@rms/dining";
import { parsePaymentIntentCreationRecord } from "@rms/payment";
import { createCustomerCapacityPaymentClaimAdmission } from "./customer-capacity-payment-admission.js";

const mocks = vi.hoisted(() => ({ factory: vi.fn(), withPaymentPending: vi.fn() }));
vi.mock("@rms/dining", async (original) => ({
  ...(await original<typeof import("@rms/dining")>()),
  createPostgresDiningCheckoutCommitmentStore: mocks.factory,
}));
beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

const id = (n: number) => "01909994-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
const scope = { tenantReference: id(90), brandReference: id(91), storeReference: id(92) };
function fixture(at: string) {
  const record = parsePaymentIntentCreationRecord({
    intent: {
      paymentIntentReference: id(1),
      paymentOperationReference: id(2),
      intentDigest: "sha256:" + "a".repeat(64),
      preparation: {
        preparationReference: id(3),
        orderReference: id(10),
        orderBatchReference: id(4),
        submissionReference: id(11),
        sourceCartReference: id(12),
        sourceCartVersion: 3,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        guestSessionReference: id(13),
        quoteReference: id(14),
        capacityAllocationReference: id(5),
        readiness: "PaymentPending",
        transactionBoundary: "OrderSubmissionPaymentPreparation",
        orderAllocation: money(848n),
        tip: money(0n),
        total: money(848n),
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
  const inventory = { admit: vi.fn().mockResolvedValue(true) };
  mocks.factory.mockReturnValue({ withPaymentPending: mocks.withPaymentPending });
  const admission = createCustomerCapacityPaymentClaimAdmission({
    scope,
    owner: "Dining",
    inventory,
  });
  return { record, admission, inventory };
}

/**
 * WP-2423 (table-move-payment review, 2026-11-06): the guest's confirm after staff moved the
 * party read Dining at the request's fixed time, so a Move recorded after it was refused on every
 * retry, and the refusal ("conflict") became "this payment is not yours" (404: payment result not
 * found, contact the store). Dining now reads at the clock's current reading (never earlier than
 * the request), and a busy or failed Dining read is thrown for Payment to answer as retryable.
 */
it("lets Dining read where the party sits now, never before the request's time", async () => {
  const requestAt = new Date(Date.now() - 5000).toISOString();
  const { record, admission } = fixture(requestAt);
  const seen: string[] = [];
  mocks.withPaymentPending.mockImplementation(async () => {
    const clock = mocks.factory.mock.calls[0]![2] as { now(): string };
    seen.push(clock.now(), clock.now());
    return true;
  });
  await expect(admission.admit({ query: vi.fn() } as never, record, requestAt)).resolves.toBe(true);
  expect(seen[0]! > requestAt).toBe(true);
  expect(seen[1]! >= seen[0]!).toBe(true);
});

it("never reads Dining earlier than the request, whatever the machine clock says", async () => {
  const requestAt = new Date(Date.now() + 60000).toISOString();
  const { record, admission } = fixture(requestAt);
  let seen = "";
  mocks.withPaymentPending.mockImplementation(async () => {
    seen = (mocks.factory.mock.calls[0]![2] as { now(): string }).now();
    return true;
  });
  await admission.admit({ query: vi.fn() } as never, record, requestAt);
  expect(seen).toBe(requestAt);
});

it.each(["DINING_CHECKOUT_STORE_CONFLICT", "DINING_CHECKOUT_STORE_UNAVAILABLE"] as const)(
  "passes a busy or failed Dining read on for a retry, not a refusal (%s)",
  async (code) => {
    const at = new Date().toISOString();
    const { record, admission } = fixture(at);
    mocks.withPaymentPending.mockRejectedValue(new DiningCheckoutStoreError(code));
    await expect(admission.admit({ query: vi.fn() } as never, record, at)).rejects.toMatchObject({
      code,
    });
  },
);

it("still refuses a round Dining no longer lets be paid, and an invalid Dining record", async () => {
  const at = new Date().toISOString();
  const { record, admission } = fixture(at);
  mocks.withPaymentPending.mockRejectedValueOnce(
    new DiningCheckoutCommitmentError("DINING_CHECKOUT_CONTEXT_CHANGED"),
  );
  await expect(admission.admit({ query: vi.fn() } as never, record, at)).resolves.toBe(false);
  mocks.withPaymentPending.mockRejectedValueOnce(
    new DiningCheckoutStoreError("DINING_CHECKOUT_STORE_INVALID"),
  );
  await expect(admission.admit({ query: vi.fn() } as never, record, at)).resolves.toBe(false);
  mocks.withPaymentPending.mockResolvedValueOnce(null);
  await expect(admission.admit({ query: vi.fn() } as never, record, at)).resolves.toBe(false);
});
