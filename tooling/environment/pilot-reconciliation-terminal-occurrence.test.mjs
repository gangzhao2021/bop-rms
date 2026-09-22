import { afterEach, expect, it, vi } from "vitest";
import { createInternalReconciliationTerminalOccurrence } from "./pilot-reconciliation-terminal-occurrence.mjs";
const id = (n) => "0198a107-0000-7000-8000-" + String(n).padStart(12, "0");
const observedAt = "2026-09-22T00:02:00.000Z",
  occurredAt = "2026-09-22T00:01:00.000Z";
const money = (amountMinor) => ({ amountMinor, currencyCode: "CAD" });
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  vi.stubEnv("NODE_ENV", "development");
  const scope = { brandReference: id(1), storeReference: id(2), providerAccountReference: id(3) };
  const candidate = {
    ...scope,
    candidateReference: id(4),
    paymentIntentReference: id(4),
    paymentAttemptReference: id(5),
    orderReference: id(6),
    providerIntentReference: "pi_TEST_12345678",
    environment: "Test",
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    internalStatus: "Pending",
    requestedAmount: money(1130n),
    capturedAmount: money(0n),
    refundedAmount: money(0n),
    lastObservedAt: occurredAt,
    dueAt: occurredAt,
  };
  const snapshot = {
    kind: "Snapshot",
    context: {
      provider: "Stripe",
      environment: "Test",
      brandReference: id(1),
      storeReference: id(2),
      paymentAttemptReference: id(5),
      operationReference: id(7),
    },
    providerIntentReference: candidate.providerIntentReference,
    providerTransactionReference: "ch_TEST_12345678",
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    status: "Captured",
    requestedAmount: money(1130n),
    authorizedAmount: money(1130n),
    capturedAmount: money(1130n),
    refundedAmount: money(0n),
    observedAt,
    evidenceDigest: "sha256:" + "a".repeat(64),
  };
  const readTerminalOccurrence = vi.fn(async () => ({ status: "Captured", occurredAt })),
    active = vi.fn(() => true),
    simulator = { simulation: true, readTerminalOccurrence };
  return {
    scope,
    candidate,
    snapshot,
    readTerminalOccurrence,
    active,
    simulator,
    read: createInternalReconciliationTerminalOccurrence({ scope, simulator, active }),
  };
}
it("returns persisted earlier occurrence for only the exact bound intent", async () => {
  const f = fixture();
  expect(await f.read(f)).toEqual({ status: "Captured", occurredAt });
  expect(f.readTerminalOccurrence).toHaveBeenCalledWith({
    operation: "RetrieveIntent",
    purpose: "RetrievePaymentIntent",
    context: f.snapshot.context,
    providerIntentReference: f.candidate.providerIntentReference,
  });
});
it.each(["account", "store", "attempt", "intent", "live"])(
  "rejects changed %s binding before Provider access",
  async (kind) => {
    const f = fixture();
    if (kind === "account") f.candidate.providerAccountReference = id(9);
    if (kind === "store") f.candidate.storeReference = id(9);
    if (kind === "attempt") f.snapshot.context.paymentAttemptReference = id(9);
    if (kind === "intent") f.snapshot.providerIntentReference = "pi_OTHER_123456";
    if (kind === "live") f.candidate.environment = "Live";
    await expect(f.read(f)).rejects.toThrow();
    expect(f.readTerminalOccurrence).not.toHaveBeenCalled();
  },
);
it.each(["status", "time", "revoked"])(
  "rejects %s after reading without inventing occurrence",
  async (kind) => {
    const f = fixture();
    f.readTerminalOccurrence.mockImplementation(async () => {
      if (kind === "revoked") f.active.mockReturnValue(false);
      return {
        status: kind === "status" ? "Failed" : "Captured",
        occurredAt: kind === "time" ? "2026-09-22T00:03:00.000Z" : occurredAt,
      };
    });
    await expect(f.read(f)).rejects.toThrow();
  },
);
it("requires development and a real configured simulator", () => {
  const f = fixture();
  vi.stubEnv("NODE_ENV", "production");
  expect(() => createInternalReconciliationTerminalOccurrence(f)).toThrow();
  vi.stubEnv("NODE_ENV", "development");
  f.simulator.simulation = false;
  expect(() => createInternalReconciliationTerminalOccurrence(f)).toThrow();
});
