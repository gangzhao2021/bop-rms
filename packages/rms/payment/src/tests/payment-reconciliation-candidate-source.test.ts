import { beforeEach, expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
const mocks = vi.hoisted(() => ({ creation: vi.fn(), terminal: vi.fn(), refunds: vi.fn() }));
vi.mock("../infrastructure/persistence/payment-intent-creation-store.js", () => ({
  createPostgresPaymentIntentCreationStore: () => ({ resolveOperation: mocks.creation }),
}));
vi.mock("../infrastructure/persistence/payment-terminal-store.js", () => ({
  createPostgresPaymentTerminalStore: () => ({ read: mocks.terminal }),
}));
vi.mock("../infrastructure/order-payment-refund-position.js", () => ({
  createPostgresOrderPaymentRefundPosition: () => mocks.refunds,
}));
import { createPostgresPaymentReconciliationCandidateSource } from "../infrastructure/persistence/payment-reconciliation-candidates.js";
const id = (n: number) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-22T00:10:00.000Z",
  createdAt = "2026-09-22T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    providerAccountReference: id(4),
    environment: "Test" as const,
  };
  const routing = {
    paymentIntentReference: id(5),
    paymentAttemptReference: id(6),
    paymentOperationReference: id(7),
    orderReference: id(8),
    createdAt,
    dueAt: createdAt,
  };
  const snapshot = {
    kind: "Snapshot",
    context: {
      environment: "Test",
      brandReference: id(2),
      storeReference: id(3),
      paymentAttemptReference: id(6),
    },
    providerIntentReference: "pi_TEST_12345678",
    status: "Captured",
    requestedAmount: { currencyCode: "CAD", amountMinor: 1130n },
    observedAt: at,
  };
  const record = {
    intent: {
      paymentIntentReference: id(5),
      paymentOperationReference: id(7),
      preparation: { orderReference: id(8) },
      createdAt,
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
    },
    attempt: {
      paymentIntentReference: id(5),
      paymentAttemptReference: id(6),
      providerEnvironment: "Test",
      createdAt,
    },
    providerOutcome: snapshot,
  };
  const fact = {
    paymentIntentReference: id(5),
    paymentAttemptReference: id(6),
    orderReference: id(8),
    paymentTransactionReference: id(9),
    providerIntentReference: snapshot.providerIntentReference,
    recordedAt: at,
    occurredAt: createdAt,
    outcome: "Succeeded",
    failureReason: null as string | null,
    amount: { currencyCode: "CAD", amountMinor: 1130n },
  };
  mocks.creation.mockResolvedValue(record);
  mocks.terminal.mockResolvedValue(fact);
  mocks.refunds.mockResolvedValue({ confirmedMinor: 1130n });
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 })),
    tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true);
  return {
    record,
    fact,
    snapshot,
    routing,
    scope,
    query,
    tx,
    authorize,
    read: createPostgresPaymentReconciliationCandidateSource({ scope, authorize }),
  };
}
it("uses committed gross capture and confirmed combined refunds under the Order fence", async () => {
  const f = fixture(),
    c = await f.read(f.tx, f.routing, at);
  expect(c.internalStatus).toBe("Captured");
  expect(c.capturedAmount.amountMinor).toBe(1130n);
  expect(c.refundedAmount.amountMinor).toBe(1130n);
  expect(f.query).toHaveBeenCalledWith(expect.stringContaining("pg_advisory_xact_lock"), [
    "PaymentReceiptOrder:" + id(2) + ":" + id(3) + ":" + id(8),
  ]);
  expect(mocks.refunds).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ paymentTransactionReference: id(9), observedAt: at }),
  );
});
it("keeps Provider success Unknown internally when terminal has not been committed", async () => {
  const f = fixture();
  mocks.terminal.mockResolvedValue(null);
  const c = await f.read(f.tx, f.routing, at);
  expect(c.internalStatus).toBe("Unknown");
  expect(c.capturedAmount.amountMinor).toBe(0n);
  expect(c.refundedAmount.amountMinor).toBe(0n);
  expect(mocks.refunds).not.toHaveBeenCalled();
});
it("preserves a nonterminal observation and a committed cancellation distinctly", async () => {
  const f = fixture();
  mocks.terminal.mockResolvedValue(null);
  f.snapshot.status = "Pending";
  expect((await f.read(f.tx, f.routing, at)).internalStatus).toBe("Pending");
  f.fact.outcome = "Failed";
  f.fact.failureReason = "Cancelled";
  mocks.terminal.mockResolvedValue(f.fact);
  expect((await f.read(f.tx, f.routing, at)).internalStatus).toBe("Cancelled");
  expect(mocks.refunds).not.toHaveBeenCalled();
});
it.each([
  "missing-record",
  "missing-snapshot",
  "scope",
  "attempt",
  "order",
  "future",
  "provider-intent",
  "refund-overflow",
  "refund-unavailable",
])("fails closed on %s instead of producing a matching candidate", async (kind) => {
  const f = fixture();
  if (kind === "missing-record") mocks.creation.mockResolvedValue(null);
  if (kind === "missing-snapshot")
    mocks.creation.mockResolvedValue({ ...f.record, providerOutcome: null });
  if (kind === "scope") f.snapshot.context.storeReference = id(99);
  if (kind === "attempt") f.record.attempt.paymentAttemptReference = id(99);
  if (kind === "order") f.fact.orderReference = id(99);
  if (kind === "future") f.fact.recordedAt = "2026-09-23T00:00:00.000Z";
  if (kind === "provider-intent") f.fact.providerIntentReference = "pi_OTHER_123456";
  if (kind === "refund-overflow") mocks.refunds.mockResolvedValue({ confirmedMinor: 1131n });
  if (kind === "refund-unavailable") mocks.refunds.mockRejectedValue(Error("private-detail"));
  await expect(f.read(f.tx, f.routing, at)).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE",
  });
});
it("denies before reads and after authorization revocation", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.read(f.tx, f.routing, at)).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
  expect(mocks.creation).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.read(f.tx, f.routing, at)).rejects.toMatchObject({
    code: "PAYMENT_RECONCILIATION_PERMISSION_DENIED",
  });
});
