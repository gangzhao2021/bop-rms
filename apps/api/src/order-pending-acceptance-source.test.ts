import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseOrderingReference, parsePaymentSucceededEnvelope } from "@rms/ordering";
import { createPendingAcceptanceCandidate } from "./order-pending-acceptance-source.js";

const id = (n: number) => `0190fa72-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const committedAt = "2026-09-20T10:00:00.000Z";
const capacityExpiresAt = "2026-09-20T10:30:00.000Z";
const observedAt = "2026-09-20T11:00:00.000Z";
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
function event(at = "2026-09-20T10:29:59.999Z") {
  return parsePaymentSucceededEnvelope({
    eventId: id(1),
    eventType: "PaymentSucceeded",
    schemaVersion: 1,
    occurredAt: at,
    producerModule: "@rms/payment",
    tenantId: id(2),
    storeId: id(3),
    aggregateType: "PaymentIntent",
    aggregateId: id(4),
    aggregateVersion: 2n,
    correlationId: id(5),
    causationId: id(6),
    actor: { type: "System" },
    payload: {
      paymentTransactionReference: id(7),
      paymentIntentReference: id(4),
      paymentAttemptReference: id(8),
      orderReference: id(9),
      amountMinor: "1130",
      currencyCode: "CAD",
      evidenceKind: "Captured",
      terminalOccurredAt: at,
    },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
  });
}
function context() {
  // This unit boundary receives owner-resolved facts; source authorization is tested separately.
  return {
    acceptance: null,
    initialExecution: { phase: "Submitted", version: 1, checkpoint: id(11) },
    order: {
      order: { aggregateVersion: 1, canonicalPhase: "Submitted", orderType: "DineIn" },
      submissionReference: id(11),
    },
    capacity: { commitment: { state: "PaymentPending" } },
    payment: {
      intent: {
        preparation: {
          committedAt,
          capacityExpiresAt,
          orderReference: id(9),
          orderBatchReference: id(10),
          submissionReference: id(11),
        },
      },
    },
    observedAt,
  } as unknown as Parameters<typeof createPendingAcceptanceCandidate>[0];
}
const options = { generateDispositionReference: () => id(12), sha256: hash };
describe("pending acceptance source after Dining payment deadline", () => {
  it("creates a bound waiting disposition for on-time capture processed later", () => {
    const pending = createPendingAcceptanceCandidate(context(), event(), options);
    expect(pending).toMatchObject({
      disposition: "AwaitingAcceptance",
      evaluatedAt: observedAt,
      sourceVersion: 1,
      sourceCheckpoint: id(11),
      paymentEventReference: id(1),
    });
  });
  it("does not admit capture at or after the deadline", () => {
    for (const at of [capacityExpiresAt, "2026-09-20T10:31:00.000Z"])
      expect(createPendingAcceptanceCandidate(context(), event(at), options)).toBeNull();
  });
  it("retains current capacity and execution fences despite on-time capture", () => {
    const base = context();
    expect(
      createPendingAcceptanceCandidate(
        { ...base, capacity: null, inventory: null },
        event(),
        options,
      ),
    ).toBeNull();
    expect(
      createPendingAcceptanceCandidate(
        { ...base, initialExecution: { ...base.initialExecution, version: 2 } },
        event(),
        options,
      ),
    ).toBeNull();
    expect(
      createPendingAcceptanceCandidate(
        {
          ...base,
          initialExecution: {
            ...base.initialExecution,
            checkpoint: parseOrderingReference(id(20)),
          },
        },
        event(),
        options,
      ),
    ).toBeNull();
  });
  it("retains Pickup processing deadline", () => {
    const base = context();
    const pickup = {
      ...base,
      order: { ...base.order, order: { ...base.order.order, orderType: "Pickup" as const } },
    };
    expect(createPendingAcceptanceCandidate(pickup, event(), options)).toBeNull();
  });
});
