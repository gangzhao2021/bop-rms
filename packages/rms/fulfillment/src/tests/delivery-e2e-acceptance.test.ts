import { describe, expect, it } from "vitest";
import {
  authorizeDeliveryCompleted,
  beginDeliverySearch,
  createDeliveryTask,
  createProviderJobResult,
  deliveryReference,
  mapProviderStatus,
  openDeliveryCompletionException,
  offerDeliveryAssignment,
  planDeliveryRemedy,
  receiveProviderEvent,
  reconcileProviderJob,
  recordCourierPickupHandoff,
  recordDeliveryProof,
  respondDeliveryAssignment,
  resolveDeliveryException,
} from "../index.js";

const id = (n: number) =>
  deliveryReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (hour: number, minute = 0) =>
  `2026-08-14T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

const plannedTask = () =>
  createDeliveryTask({
    taskReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    fulfillmentReference: id(5),
    orderReference: id(6),
    fulfillmentType: "Delivery",
    fulfillmentStatus: "Planned",
    addressSnapshotReference: id(7),
    confirmedWindowReference: id(8),
    capacityAllocationReference: id(9),
    requirementsReference: id(10),
    occurredAt: at(8),
  });

const offeredTask = () =>
  offerDeliveryAssignment(
    beginDeliverySearch(plannedTask(), { expectedVersion: 1, occurredAt: at(8, 5) }),
    {
      expectedVersion: 2,
      attemptReference: id(11),
      targetType: "ExternalProvider",
      targetReference: id(12),
      dispatchMode: "Automatic",
      dispatchPolicyVersionReference: id(13),
      routePlanVersionReference: id(14),
      assignmentVersion: 1,
      offeredAt: at(8, 10),
      expiresAt: at(8, 20),
      dispatchDeadline: at(8, 30),
      maxAutomaticAttempts: 3,
      idempotencyReference: id(15),
      candidateEvidence: { available: "Available", requirementsMatched: true, hardBlocked: false },
    },
  );

const providerEnvelope = () =>
  receiveProviderEvent({
    envelopeReference: id(20),
    providerAccountReference: id(21),
    externalJobReference: id(22),
    providerEventReference: id(23),
    occurredAt: at(8, 11),
    receivedAt: at(8, 12),
    replayWindowSeconds: 300,
    signatureVerified: true,
    timestampVerified: true,
    payloadVersion: "2026-01",
    payloadHash: "a".repeat(64),
    mappingVersionReference: id(24),
  });

describe("WP-2155 Delivery acceptance", () => {
  it("completes the pinned assignment, custody and proof journey without inferring delivery", () => {
    const accepted = respondDeliveryAssignment(offeredTask(), {
      expectedVersion: 3,
      attemptReference: id(11),
      assignmentVersion: 1,
      outcome: "Accepted",
      reasonCode: "PROVIDER_ACCEPTED",
      respondedAt: at(8, 15),
    });
    const handoff = recordCourierPickupHandoff({
      handoffReference: id(30),
      taskReference: accepted.taskReference,
      assignmentAttemptReference: id(11),
      assignmentVersion: 1,
      currentAssignmentVersion: 1,
      assignmentStatus: accepted.assignmentStatus,
      staffActorReference: id(31),
      courierOrProviderReference: id(12),
      packageReferences: [id(32)],
      expectedPackageCount: 1,
      itemResultReferences: [id(33)],
      allItemsReadyAndComplete: true,
      sealEvidenceReference: id(34),
      staffConfirmed: true,
      courierOrProviderConfirmed: true,
      itemsMayHaveLeftStore: false,
      technicalFailure: false,
      occurredAt: at(9),
    });
    const proof = recordDeliveryProof({
      proofReference: id(35),
      revision: 1,
      taskReference: accepted.taskReference,
      assignmentReference: id(11),
      policyVersionReference: id(36),
      requiredMethodGroups: [["OTP", "Signature"]],
      methods: ["OTP"],
      recipientType: "Customer",
      assetReferences: [],
      integrityHashes: [],
      deliveredAt: at(10),
      createdAt: at(10, 1),
      locationAccepted: true,
      quantitiesAccepted: true,
      recipientAccepted: true,
      providerEvidenceAccepted: true,
      technicalIndeterminate: false,
      managerOverride: null,
    });

    expect(handoff.status).toBe("Validated");
    expect(authorizeDeliveryCompleted(proof)).toMatchObject({
      taskReference: id(1),
      executionStatus: "Delivered",
    });
  });

  it("rejects a late assignment response and leaves the pending offer unchanged", () => {
    const offered = offeredTask();
    expect(() =>
      respondDeliveryAssignment(offered, {
        expectedVersion: 3,
        attemptReference: id(11),
        assignmentVersion: 1,
        outcome: "Accepted",
        reasonCode: "LATE_ACCEPT",
        respondedAt: at(8, 20),
      }),
    ).toThrow();
    expect(offered).toMatchObject({ assignmentStatus: "Offered", aggregateVersion: 3 });
    expect(offered.attempts[0]?.outcome).toBe("Pending");
  });

  it("deduplicates Provider events and quarantines conflicting terminal outcomes", () => {
    const envelope = providerEnvelope();
    expect(
      mapProviderStatus({
        envelope,
        externalStatus: "accepted",
        mapping: { accepted: { assignment: "Accepted", execution: "Planned" } },
        seenProviderEventReferences: [id(23)],
        currentAssignmentStatus: "Offered",
        currentExecutionStatus: "Planned",
      }),
    ).toMatchObject({ outcome: "Duplicate", exceptionRequired: false });
    expect(
      mapProviderStatus({
        envelope,
        externalStatus: "failed",
        mapping: { failed: { assignment: "Accepted", execution: "Failed" } },
        seenProviderEventReferences: [],
        currentAssignmentStatus: "Accepted",
        currentExecutionStatus: "Delivered",
      }),
    ).toMatchObject({ outcome: "TerminalConflict", exceptionRequired: true });
  });

  it("keeps a timed-out Provider create indeterminate until verified reconciliation", () => {
    const timedOut = createProviderJobResult({
      operationReference: id(40),
      idempotencyReference: id(41),
      transportOutcome: "Timeout",
      externalJobReference: null,
    });
    expect(timedOut.status).toBe("Indeterminate");
    expect(
      reconcileProviderJob(timedOut, {
        idempotencyReference: id(41),
        externalJobReference: null,
        evidenceVerified: false,
      }),
    ).toBe(timedOut);
    expect(
      reconcileProviderJob(timedOut, {
        idempotencyReference: id(41),
        externalJobReference: id(42),
        evidenceVerified: true,
      }).status,
    ).toBe("Accepted");
  });

  it("requires fresh remedy evidence and owning finality without exposing delivery PII", () => {
    const exception = openDeliveryCompletionException({
      exceptionReference: id(50),
      taskReference: id(1),
      orderReference: id(6),
      triggeringAttemptReference: id(11),
      reason: "CUSTOMER_UNAVAILABLE",
      severity: "Delayed",
      customerImpact: "Delayed",
      resolutionDeadline: at(12),
      occurredAt: at(10),
      hasActiveCompletionException: false,
    });
    expect(() =>
      planDeliveryRemedy(exception, {
        expectedVersion: 1,
        attemptReference: id(51),
        kind: "Reroute",
        occurredAt: at(10, 10),
        maxReattempts: 2,
        latestReattemptAt: at(11),
        windowReference: id(52),
        capacityReference: id(53),
        proofPolicyReference: id(54),
        evidence: {
          customerAvailable: true,
          addressAndInstructionsCurrent: false,
          packageFreshAndSafe: true,
          assignmentEligible: true,
          capacityAccepted: true,
          hardBlocked: false,
        },
      }),
    ).toThrow();
    expect(() =>
      resolveDeliveryException(exception, {
        expectedVersion: 1,
        resolution: "FulfillmentFailed",
        resolutionEvidenceReference: id(55),
        occurredAt: at(11),
        evidence: {
          validatedDeliveryProof: false,
          validatedReturnHandoff: false,
          disposalPolicyAuthorized: false,
          orderingCancelled: false,
          remediesExhausted: true,
          noActiveCriticalException: true,
          allItemsFinal: false,
          failureAuthorized: true,
          noActualHandlingNeeded: false,
        },
      }),
    ).toThrow();
    const serialized = JSON.stringify(exception);
    for (const prohibited of [
      "address",
      "contact",
      "phone",
      "email",
      "latitude",
      "longitude",
      "providerPayload",
    ])
      expect(serialized.toLowerCase()).not.toContain(prohibited.toLowerCase());
  });
});
