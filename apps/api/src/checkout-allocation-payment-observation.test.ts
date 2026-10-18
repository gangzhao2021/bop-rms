import { expect, it, vi, beforeEach } from "vitest";
const mocks = vi.hoisted(() => ({ creation: vi.fn(), terminal: vi.fn(), card: vi.fn() }));
vi.mock("@rms/payment", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createPostgresPaymentIntentCreationStore: () => ({ resolveOperation: mocks.creation }),
  createPostgresPaymentTerminalStore: () => ({ read: mocks.terminal }),
  // WP-2423 Q7: a payment staff recorded from the Store's card machine.
  createPostgresCardMachinePaymentStore: () => ({ loadByPaymentOperation: mocks.card }),
}));
import { createCheckoutAllocationPaymentObservation } from "./checkout-allocation-payment-observation.js";
const id = (n: number) => "0190ed94-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = {
  brandReference: id(1),
  storeReference: id(2),
  providerAccountReference: id(3),
  environment: "Test" as const,
};
const at = "2026-09-20T12:00:00.000Z";
const allocation = () => ({
  brandReference: id(1),
  storeReference: id(2),
  guestSessionReference: id(4),
  cartReference: id(5),
  cartVersion: 2,
  quoteReference: id(6),
  quoteVersion: 1,
  createOperationReference: id(7),
  checkoutSessionReference: id(8),
  submissionReference: id(9),
  paymentOperationReference: id(10),
  allocatedAt: "2026-09-20T11:00:00.000Z",
});
const payment = () => ({
  intent: {
    paymentIntentReference: id(11),
    paymentOperationReference: id(10),
    intentDigest: "sha256:" + "a".repeat(64),
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    aggregateVersion: 1,
    creationStatus: "ProviderCreatePending",
    createdAt: "2026-09-20T11:01:00.000Z",
    preparation: {
      preparationReference: id(13),
      orderReference: id(14),
      orderBatchReference: id(15),
      submissionReference: id(9),
      sourceCartReference: id(5),
      sourceCartVersion: 2,
      brandReference: id(1),
      storeReference: id(2),
      guestSessionReference: id(4),
      quoteReference: id(6),
      capacityAllocationReference: id(16),
      readiness: "PaymentPending",
      transactionBoundary: "OrderSubmissionPaymentPreparation",
      orderAllocation: { amountMinor: 1130n, currencyCode: "CAD" },
      tip: { amountMinor: 0n, currencyCode: "CAD" },
      total: { amountMinor: 1130n, currencyCode: "CAD" },
      committedAt: "2026-09-20T11:00:30.000Z",
      capacityExpiresAt: "2026-09-20T11:31:00.000Z",
      sourceDigest: "sha256:" + "b".repeat(64),
    },
  },
  attempt: {
    paymentAttemptReference: id(12),
    paymentIntentReference: id(11),
    attemptNumber: 1,
    provider: "Stripe",
    providerEnvironment: "Test",
    providerIdempotencyDigest: "sha256:" + "c".repeat(64),
    createdAt: "2026-09-20T11:01:00.000Z",
  },
  providerOutcome: null,
});
const terminal = () => ({
  ...scope,
  paymentIntentReference: id(11),
  paymentAttemptReference: id(12),
  orderReference: id(14),
  outcome: "Succeeded",
  amount: { amountMinor: 1130n, currencyCode: "CAD" },
  recordedAt: "2026-09-20T11:02:01.000Z",
  occurredAt: "2026-09-20T11:02:00.000Z",
});
const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
function fixture() {
  const authorize = vi.fn(async () => true);
  return {
    authorize,
    source: createCheckoutAllocationPaymentObservation({ scope, now: () => at, authorize }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.creation.mockResolvedValue(payment());
  mocks.terminal.mockResolvedValue(terminal());
  mocks.card.mockResolvedValue(null);
});
it("matches exact allocation to captured Payment without claiming whole-order clearance", async () => {
  const f = fixture(),
    result = await f.source.resolve(tx, allocation());
  expect(result.status).toBe("Terminal");
  if (result.status !== "Terminal") throw new Error("fixture result");
  expect(result.outcome).toBe("Succeeded");
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(mocks.creation).toHaveBeenCalledWith(id(10));
  expect(mocks.terminal).toHaveBeenCalledWith(id(11));
});
it.each(["creation", "terminal"] as const)(
  "missing %s stays unresolved after original deadline",
  async (port) => {
    mocks[port].mockResolvedValue(null);
    expect(await fixture().source.resolve(tx, allocation())).toMatchObject({
      status: "Unresolved",
    });
  },
);
it("preserves authoritative Failed terminal without guessing from Provider creation result", async () => {
  mocks.terminal.mockResolvedValue({ ...terminal(), outcome: "Failed", amount: null });
  expect(await fixture().source.resolve(tx, allocation())).toMatchObject({
    status: "Terminal",
    outcome: "Failed",
  });
});
it.each(["sourceCartReference", "quoteReference", "submissionReference", "guestSessionReference"])(
  "rejects mismatched %s",
  async (field) => {
    const p = payment();
    mocks.creation.mockResolvedValue({
      ...p,
      intent: { ...p.intent, preparation: { ...p.intent.preparation, [field]: id(99) } },
    });
    await expect(fixture().source.resolve(tx, allocation())).rejects.toThrow(
      "CHECKOUT_PAYMENT_OBSERVATION_UNAVAILABLE",
    );
  },
);
it.each([
  { providerAccountReference: id(99) },
  { environment: "Live" },
  { paymentAttemptReference: id(99) },
  { amount: { amountMinor: 1131n, currencyCode: "CAD" } },
  { recordedAt: "2099-01-01T00:00:00.000Z" },
])("rejects incoherent terminal case %#", async (change) => {
  mocks.terminal.mockResolvedValue({ ...terminal(), ...change });
  await expect(fixture().source.resolve(tx, allocation())).rejects.toThrow();
});
it("denies revoked authorization even when terminal facts exist", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.source.resolve(tx, allocation())).rejects.toThrow();
});
it("denies foreign scope before owner reads", async () => {
  await expect(
    fixture().source.resolve(tx, { ...allocation(), storeReference: id(99) }),
  ).rejects.toThrow();
  expect(mocks.creation).not.toHaveBeenCalled();
});

// WP-2423 Q7 slice 2: a counter order or staff-entered dine-in round paid on the card machine is
// this checkout's successful payment, so the payment window expiry records it as paid in time.
it("reads a card-machine payment of the checkout as its successful terminal payment", async () => {
  mocks.creation.mockResolvedValue(null);
  const card = {
    tenantReference: id(30),
    brandReference: id(1),
    storeReference: id(2),
    cardMachinePaymentReference: id(31),
    paymentIntentReference: id(32),
    paymentAttemptReference: id(33),
    paymentOperationReference: id(10),
    operationReference: id(34),
    intentDigest: "sha256:" + "d".repeat(64),
    orderReference: id(14),
    orderBatchReference: id(15),
    submissionReference: id(9),
    preparation: payment().intent.preparation,
    environment: "Test",
    slipReference: null,
    recordingReason: "AtCounter",
    takenAt: "2026-09-20T11:05:00.000Z",
    recordedAt: "2026-09-20T11:05:00.000Z",
    actorReference: id(35),
    eventReference: id(36),
    auditReference: id(37),
  };
  mocks.card.mockResolvedValue(card);
  const result = await fixture().source.resolve(tx, allocation());
  expect(mocks.card).toHaveBeenCalledWith(tx, id(10));
  expect(result).toMatchObject({ status: "Terminal", outcome: "Succeeded" });
  if (result.status !== "Terminal") throw new Error("fixture result");
  expect(result.payment.intent.paymentMethod).toBe("StoreCardMachine");
  expect(result.terminal.occurredAt).toBe(card.recordedAt);
  // Another checkout's card-machine payment is never taken for this one.
  mocks.card.mockResolvedValue({
    ...card,
    preparation: { ...card.preparation, submissionReference: id(99) },
  });
  await expect(fixture().source.resolve(tx, allocation())).rejects.toThrow(
    "CHECKOUT_PAYMENT_OBSERVATION_UNAVAILABLE",
  );
});
