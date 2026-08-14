import { describe, expect, it } from "vitest";
import {
  createProviderJobResult,
  deliveryReference,
  mapProviderStatus,
  providerEligibleForOffer,
  providerQuote,
  receiveProviderEvent,
  reconcileProviderJob,
  type DeliveryProviderAccount,
} from "../index.js";
const id = (n: number) =>
  deliveryReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const account = (overrides: Partial<DeliveryProviderAccount> = {}): DeliveryProviderAccount => ({
  accountReference: id(1),
  brandReference: id(2),
  merchantAccountReference: id(3),
  secretReference: id(4),
  lifecycle: "Active",
  health: "Healthy",
  storeReferences: [id(5)],
  activationEvidenceReferences: [id(10), id(11), id(12), id(13), id(14)],
  breakers: {
    Quote: "Closed",
    Create: "Closed",
    Status: "Closed",
    Cancel: "Closed",
    Webhook: "Closed",
  },
  ...overrides,
});
const envelope = () =>
  receiveProviderEvent({
    envelopeReference: id(20),
    providerAccountReference: id(1),
    externalJobReference: id(21),
    providerEventReference: id(22),
    occurredAt: "2026-08-14T10:00:00.000Z",
    receivedAt: "2026-08-14T10:01:00.000Z",
    replayWindowSeconds: 300,
    signatureVerified: true,
    timestampVerified: true,
    payloadVersion: "2026-01",
    payloadHash: "a".repeat(64),
    mappingVersionReference: id(23),
  });
describe("Delivery Provider adapter boundary", () => {
  it("requires Active, known usable Health, activation proof, Store scope and usable breaker", () => {
    expect(
      providerEligibleForOffer(account(), {
        storeReference: id(5),
        operation: "Create",
        probeAuthorized: false,
      }),
    ).toBe(true);
    expect(
      providerEligibleForOffer(account({ health: "Unknown" }), {
        storeReference: id(5),
        operation: "Create",
        probeAuthorized: false,
      }),
    ).toBe(false);
    expect(
      providerEligibleForOffer(account({ breakers: { ...account().breakers, Create: "Open" } }), {
        storeReference: id(5),
        operation: "Create",
        probeAuthorized: false,
      }),
    ).toBe(false);
  });
  it("rejects unsigned, stale or unverified webhook envelopes", () => {
    expect(envelope()).toMatchObject({
      payloadHash: "a".repeat(64),
      providerEventReference: id(22),
    });
    expect(() =>
      receiveProviderEvent({
        ...envelope(),
        replayWindowSeconds: 30,
        signatureVerified: false,
        timestampVerified: true,
        payloadVersion: "v1",
        payloadHash: "b".repeat(64),
        mappingVersionReference: id(23),
        occurredAt: "2026-08-14T10:00:00.000Z",
        receivedAt: "2026-08-14T10:01:00.000Z",
      }),
    ).toThrow();
  });
  it("deduplicates Provider Account + Event ID without applying twice", () => {
    expect(
      mapProviderStatus({
        envelope: envelope(),
        externalStatus: "accepted",
        mapping: { accepted: { assignment: "Accepted", execution: "Planned" } },
        seenProviderEventReferences: [id(22)],
        currentAssignmentStatus: "Offered",
        currentExecutionStatus: "Planned",
      }).outcome,
    ).toBe("Duplicate");
  });
  it("quarantines unknown status and prevents out-of-order regression", () => {
    expect(
      mapProviderStatus({
        envelope: envelope(),
        externalStatus: "mystery",
        mapping: {},
        seenProviderEventReferences: [],
        currentAssignmentStatus: "Accepted",
        currentExecutionStatus: "EnRoute",
      }),
    ).toMatchObject({ outcome: "Quarantined", exceptionRequired: true });
    expect(
      mapProviderStatus({
        envelope: envelope(),
        externalStatus: "picked",
        mapping: { picked: { assignment: "Accepted", execution: "PickedUp" } },
        seenProviderEventReferences: [],
        currentAssignmentStatus: "Accepted",
        currentExecutionStatus: "EnRoute",
      }),
    ).toMatchObject({ outcome: "IgnoredOutOfOrder", executionStatus: "EnRoute" });
  });
  it("opens an exception for conflicting terminal Provider state", () => {
    expect(
      mapProviderStatus({
        envelope: envelope(),
        externalStatus: "failed",
        mapping: { failed: { assignment: "Accepted", execution: "Failed" } },
        seenProviderEventReferences: [],
        currentAssignmentStatus: "Accepted",
        currentExecutionStatus: "Delivered",
      }),
    ).toMatchObject({
      outcome: "TerminalConflict",
      exceptionRequired: true,
      executionStatus: "Delivered",
    });
  });
  it("keeps Create timeout indeterminate until verified reconciliation", () => {
    const creation = createProviderJobResult({
      operationReference: id(30),
      idempotencyReference: id(31),
      transportOutcome: "Timeout",
      externalJobReference: null,
    });
    expect(creation.status).toBe("Indeterminate");
    expect(
      reconcileProviderJob(creation, {
        idempotencyReference: id(31),
        externalJobReference: null,
        evidenceVerified: false,
      }),
    ).toBe(creation);
    expect(
      reconcileProviderJob(creation, {
        idempotencyReference: id(31),
        externalJobReference: id(32),
        evidenceVerified: true,
      }),
    ).toMatchObject({ status: "Accepted", externalJobReference: id(32) });
  });
  it("uses exact, unexpired Provider cost without changing Customer fee", () => {
    expect(
      providerQuote({
        quoteReference: id(40),
        amountMinor: 1299,
        currency: "CAD",
        quotedAt: "2026-08-14T10:00:00.000Z",
        expiresAt: "2026-08-14T10:10:00.000Z",
        usedAt: "2026-08-14T10:05:00.000Z",
        maxProviderCostMinor: 1500,
        managerApproved: false,
      }),
    ).toMatchObject({ amountMinor: 1299, currency: "CAD" });
    expect(() =>
      providerQuote({
        quoteReference: id(40),
        amountMinor: 1600,
        currency: "CAD",
        quotedAt: "2026-08-14T10:00:00.000Z",
        expiresAt: "2026-08-14T10:10:00.000Z",
        usedAt: "2026-08-14T10:10:00.000Z",
        maxProviderCostMinor: 1500,
        managerApproved: false,
      }),
    ).toThrow();
  });
});
