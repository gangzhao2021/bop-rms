import { describe, expect, it } from "vitest";
import {
  authorizeDeliveryCompleted,
  deliveryReference,
  recordCourierPickupHandoff,
  recordDeliveryProof,
} from "../index.js";
const id = (n: number) =>
  deliveryReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const handoff = (overrides: Record<string, unknown> = {}) =>
  recordCourierPickupHandoff({
    handoffReference: id(1),
    taskReference: id(2),
    assignmentAttemptReference: id(3),
    assignmentVersion: 4,
    currentAssignmentVersion: 4,
    assignmentStatus: "Accepted",
    staffActorReference: id(4),
    courierOrProviderReference: id(5),
    packageReferences: [id(6), id(7)],
    expectedPackageCount: 2,
    itemResultReferences: [id(8)],
    allItemsReadyAndComplete: true,
    sealEvidenceReference: id(9),
    staffConfirmed: true,
    courierOrProviderConfirmed: true,
    itemsMayHaveLeftStore: false,
    technicalFailure: false,
    occurredAt: "2026-08-14T10:00:00.000Z",
    ...overrides,
  });
const proof = (overrides: Record<string, unknown> = {}) =>
  recordDeliveryProof({
    proofReference: id(20),
    revision: 1,
    taskReference: id(2),
    assignmentReference: id(3),
    policyVersionReference: id(21),
    requiredMethodGroups: [["OTP", "Signature"], ["Photo"]],
    methods: ["OTP", "Photo"],
    recipientType: "LeaveAtDoor",
    assetReferences: [id(22)],
    integrityHashes: ["a".repeat(64)],
    deliveredAt: "2026-08-14T11:00:00.000Z",
    createdAt: "2026-08-14T11:01:00.000Z",
    locationAccepted: true,
    quantitiesAccepted: true,
    recipientAccepted: true,
    providerEvidenceAccepted: true,
    technicalIndeterminate: false,
    managerOverride: null,
    ...overrides,
  });
describe("Delivery handoff and proof", () => {
  it("validates complete dual-confirmed current-assignment custody", () => {
    expect(handoff()).toMatchObject({
      status: "Validated",
      custodyExceptionRequired: false,
      assignmentVersion: 4,
    });
  });
  it("requires custody review when items may have left with incomplete evidence", () => {
    expect(
      handoff({ courierOrProviderConfirmed: false, itemsMayHaveLeftStore: true }),
    ).toMatchObject({ status: "NeedsReview", custodyExceptionRequired: true });
  });
  it("rejects stale assignment and partial normal pickup", () => {
    expect(() => handoff({ currentAssignmentVersion: 5 })).toThrow();
    expect(handoff({ packageReferences: [id(6)] }).status).toBe("Rejected");
  });
  it("validates pinned AND/OR proof and authorizes Delivered only then", () => {
    const accepted = proof();
    expect(accepted.status).toBe("Validated");
    expect(authorizeDeliveryCompleted(accepted).executionStatus).toBe("Delivered");
  });
  it("treats technical uncertainty as review instead of rejection", () => {
    const uncertain = proof({ technicalIndeterminate: true, providerEvidenceAccepted: false });
    expect(uncertain.status).toBe("NeedsReview");
    expect(() => authorizeDeliveryCompleted(uncertain)).toThrow();
  });
  it("blocks self-approved or hard-requirement override", () => {
    expect(
      proof({
        methods: [],
        managerOverride: {
          managerReference: id(30),
          executorReference: id(30),
          secondApproverReference: id(31),
          hardRequirement: false,
          highRisk: true,
        },
      }).status,
    ).toBe("Rejected");
    expect(
      proof({
        methods: [],
        managerOverride: {
          managerReference: id(30),
          executorReference: id(32),
          secondApproverReference: id(31),
          hardRequirement: true,
          highRisk: true,
        },
      }).status,
    ).toBe("Rejected");
  });
});
