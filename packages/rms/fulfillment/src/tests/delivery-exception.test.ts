import { describe, expect, it } from "vitest";
import {
  assignDeliveryException,
  deliveryReference,
  finalizeReturnDisposition,
  openDeliveryCompletionException,
  planDeliveryRemedy,
  resolveDeliveryException,
} from "../index.js";
const id = (n: number) =>
  deliveryReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const opened = () =>
  openDeliveryCompletionException({
    exceptionReference: id(1),
    taskReference: id(2),
    orderReference: id(3),
    triggeringAttemptReference: id(4),
    reason: "CUSTOMER_UNAVAILABLE",
    severity: "Delayed",
    customerImpact: "Delayed",
    resolutionDeadline: "2026-08-14T12:00:00.000Z",
    occurredAt: "2026-08-14T10:00:00.000Z",
    hasActiveCompletionException: false,
  });
const resolutionEvidence = (overrides: Record<string, boolean> = {}) => ({
  validatedDeliveryProof: false,
  validatedReturnHandoff: false,
  disposalPolicyAuthorized: false,
  orderingCancelled: false,
  remediesExhausted: false,
  noActiveCriticalException: false,
  allItemsFinal: false,
  failureAuthorized: false,
  noActualHandlingNeeded: false,
  ...overrides,
});
describe("Delivery completion exception", () => {
  it("opens one explicit exception with separate lifecycle, severity and SLA", () => {
    expect(opened()).toMatchObject({
      lifecycle: "Open",
      severity: "Delayed",
      customerImpact: "Delayed",
      aggregateVersion: 1,
    });
    expect(() =>
      openDeliveryCompletionException({
        ...opened(),
        exceptionReference: id(8),
        taskReference: id(2),
        orderReference: id(3),
        triggeringAttemptReference: id(4),
        reason: "CUSTOMER_UNAVAILABLE",
        severity: "Delayed",
        customerImpact: "Delayed",
        resolutionDeadline: "2026-08-14T12:00:00.000Z",
        occurredAt: "2026-08-14T10:00:00.000Z",
        hasActiveCompletionException: true,
      }),
    ).toThrow();
  });
  it("assigns an owner with exact version and preserves history", () => {
    expect(
      assignDeliveryException(opened(), {
        expectedVersion: 1,
        ownerReference: id(10),
        occurredAt: "2026-08-14T10:05:00.000Z",
      }),
    ).toMatchObject({ ownerReference: id(10), lifecycle: "Contacting", aggregateVersion: 2 });
  });
  it("plans a new-sequence remedy only with complete capacity/freshness/proof evidence", () => {
    const remedy = planDeliveryRemedy(opened(), {
      expectedVersion: 1,
      attemptReference: id(11),
      kind: "Reattempt",
      occurredAt: "2026-08-14T10:10:00.000Z",
      maxReattempts: 2,
      latestReattemptAt: "2026-08-14T11:00:00.000Z",
      windowReference: id(12),
      capacityReference: id(13),
      proofPolicyReference: id(14),
      evidence: {
        customerAvailable: true,
        addressAndInstructionsCurrent: true,
        packageFreshAndSafe: true,
        assignmentEligible: true,
        capacityAccepted: true,
        hardBlocked: false,
      },
    });
    expect(remedy.remedyAttempts[0]).toMatchObject({ sequence: 1, kind: "Reattempt" });
    expect(remedy.taskReference).toBe(id(2));
  });
  it("blocks reroute on hard block or missing capacity", () => {
    expect(() =>
      planDeliveryRemedy(opened(), {
        expectedVersion: 1,
        attemptReference: id(11),
        kind: "Reroute",
        occurredAt: "2026-08-14T10:10:00.000Z",
        maxReattempts: 2,
        latestReattemptAt: "2026-08-14T11:00:00.000Z",
        windowReference: id(12),
        capacityReference: id(13),
        proofPolicyReference: id(14),
        evidence: {
          customerAvailable: true,
          addressAndInstructionsCurrent: true,
          packageFreshAndSafe: true,
          assignmentEligible: true,
          capacityAccepted: false,
          hardBlocked: false,
        },
      }),
    ).toThrow();
  });
  it("requires owning facts for Delivered, Cancelled and Failed resolution", () => {
    expect(
      resolveDeliveryException(opened(), {
        expectedVersion: 1,
        resolution: "DeliveredOnReattempt",
        resolutionEvidenceReference: id(20),
        occurredAt: "2026-08-14T11:00:00.000Z",
        evidence: resolutionEvidence({ validatedDeliveryProof: true }),
      }).taskEffect,
    ).toBe("Delivered");
    expect(() =>
      resolveDeliveryException(opened(), {
        expectedVersion: 1,
        resolution: "CancelledByOrdering",
        resolutionEvidenceReference: id(20),
        occurredAt: "2026-08-14T11:00:00.000Z",
        evidence: resolutionEvidence(),
      }),
    ).toThrow();
    expect(
      resolveDeliveryException(opened(), {
        expectedVersion: 1,
        resolution: "FulfillmentFailed",
        resolutionEvidenceReference: id(20),
        occurredAt: "2026-08-14T11:00:00.000Z",
        evidence: resolutionEvidence({
          remediesExhausted: true,
          noActiveCriticalException: true,
          allItemsFinal: true,
          failureAuthorized: true,
        }),
      }).taskEffect,
    ).toBe("Failed");
  });
  it("finalizes return disposition only after validated return and owner action finality", () => {
    expect(
      finalizeReturnDisposition({
        returnHandoffStatus: "Validated",
        disposition: "RemakeRequired",
        ownerActionReference: id(30),
        ownerActionFinal: true,
      }),
    ).toMatchObject({ status: "Finalized", ownerActionReference: id(30) });
    expect(() =>
      finalizeReturnDisposition({
        returnHandoffStatus: "NeedsReview",
        disposition: "EligibleForReattempt",
        ownerActionReference: id(30),
        ownerActionFinal: true,
      }),
    ).toThrow();
  });
});
