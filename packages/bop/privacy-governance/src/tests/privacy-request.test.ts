import { describe, expect, it } from "vitest";
import {
  addPrivacyOwnerWork,
  attachPrivacyExport,
  attachPrivacyHold,
  completePrivacyOwnerWork,
  createPrivacyRequest,
  createPrivacyTombstone,
  privacyInstant,
  privacyReference,
  transitionPrivacyRequest,
} from "../index.js";
const id = (n: number) =>
  privacyReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const at = (day: number, hour = 0) =>
  privacyInstant(
    `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00.000Z`,
  );
const intake = (right: "AccessPortability" | "DeletionAnonymization" = "AccessPortability") =>
  createPrivacyRequest({
    requestReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    subjectReference: id(4),
    right,
    actorReference: id(5),
    evidenceReference: id(6),
    occurredAt: at(1),
    dueAt: at(31),
  });
const assigned = () => {
  const verified = transitionPrivacyRequest(intake(), {
    expectedVersion: 1,
    targetStatus: "Verified",
    actorReference: id(5),
    evidenceReference: id(6),
    reasonCode: "IDENTITY_VERIFIED",
    occurredAt: at(2),
    verificationReference: id(7),
  });
  return transitionPrivacyRequest(verified, {
    expectedVersion: 2,
    targetStatus: "Assigned",
    actorReference: id(5),
    evidenceReference: id(8),
    reasonCode: "OWNER_ASSIGNED",
    occurredAt: at(3),
    ownerReference: id(9),
  });
};
describe("Privacy Rights Request", () => {
  it("creates a tracked request with the exact 30-calendar-day target", () => {
    expect(intake()).toMatchObject({ status: "Intake", dueAt: at(31), aggregateVersion: 1 });
  });
  it("requires proportional verification before assignment", () => {
    expect(() =>
      transitionPrivacyRequest(intake(), {
        expectedVersion: 1,
        targetStatus: "Verified",
        actorReference: id(5),
        evidenceReference: id(6),
        reasonCode: "VERIFY",
        occurredAt: at(2),
      }),
    ).toThrow();
  });
  it("coordinates owner work without modifying owner facts", () => {
    const request = addPrivacyOwnerWork(assigned(), {
      expectedVersion: 3,
      ownerModule: "@rms/customer-loyalty",
      scopeReference: id(10),
      actorReference: id(5),
      evidenceReference: id(11),
      occurredAt: at(4),
    });
    const completed = completePrivacyOwnerWork(request, {
      expectedVersion: 4,
      scopeReference: id(10),
      status: "Completed",
      outcomeReference: id(12),
      reasonCode: "ANONYMIZED_NON_REQUIRED",
      actorReference: id(5),
      evidenceReference: id(13),
      occurredAt: at(5),
    });
    expect(completed.workItems[0]).toMatchObject({ status: "Completed", outcomeReference: id(12) });
  });
  it("requires a recorded hold before a Data Owner can report hold blocking", () => {
    const request = addPrivacyOwnerWork(assigned(), {
      expectedVersion: 3,
      ownerModule: "@rms/payment",
      scopeReference: id(10),
      actorReference: id(5),
      evidenceReference: id(11),
      occurredAt: at(4),
    });
    expect(() =>
      completePrivacyOwnerWork(request, {
        expectedVersion: 4,
        scopeReference: id(10),
        status: "BlockedByHold",
        outcomeReference: id(12),
        reasonCode: "STATUTORY_RETENTION",
        actorReference: id(5),
        evidenceReference: id(13),
        occurredAt: at(5),
      }),
    ).toThrow();
    const held = attachPrivacyHold(request, {
      expectedVersion: 4,
      holdReference: id(14),
      actorReference: id(5),
      evidenceReference: id(15),
      occurredAt: at(5),
    });
    expect(
      completePrivacyOwnerWork(held, {
        expectedVersion: 5,
        scopeReference: id(10),
        status: "BlockedByHold",
        outcomeReference: id(12),
        reasonCode: "STATUTORY_RETENTION",
        actorReference: id(5),
        evidenceReference: id(13),
        occurredAt: at(6),
      }).workItems[0]?.status,
    ).toBe("BlockedByHold");
  });
  it("accepts only encrypted single-use exports no longer than 24 hours", () => {
    const request = assigned();
    expect(
      attachPrivacyExport(request, {
        expectedVersion: 3,
        artifactReference: id(20),
        encrypted: true,
        singleUse: true,
        expiresAt: at(4, 23),
        actorReference: id(5),
        evidenceReference: id(21),
        occurredAt: at(4),
      }).exportEvidence,
    ).toMatchObject({ encrypted: true, singleUse: true });
    expect(() =>
      attachPrivacyExport(request, {
        expectedVersion: 3,
        artifactReference: id(20),
        encrypted: true,
        singleUse: true,
        expiresAt: at(6),
        actorReference: id(5),
        evidenceReference: id(21),
        occurredAt: at(4),
      }),
    ).toThrow();
  });
  it("creates a minimal tombstone excluded from product search and analytics", () => {
    const tombstone = createPrivacyTombstone({
      opaqueSubjectId: id(4),
      fieldReference: id(22),
      policyVersion: "policy-1",
      completedAt: at(5),
      replayStatus: "Pending",
    });
    expect(tombstone).toEqual({
      opaqueSubjectId: id(4),
      fieldReference: id(22),
      policyVersion: "policy-1",
      completedAt: at(5),
      replayStatus: "Pending",
      productSearch: false,
      analytics: false,
    });
    expect(JSON.stringify(tombstone)).not.toMatch(/email|phone|name/i);
  });
});
