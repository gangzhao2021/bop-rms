import { describe, expect, it } from "vitest";
import {
  createDeliveryDetail,
  deliveryOperationalSnapshot,
  deliveryReference,
  reviseDeliverySnapshot,
} from "../index.js";
const id = (n: number) =>
  deliveryReference(`00000000-0000-7000-8000-${String(n).padStart(12, "0")}`);
const instant = (minute: number) => `2026-08-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
const snapshot = (n = 10) =>
  deliveryOperationalSnapshot({
    snapshotReference: id(n),
    stableAddressReference: id(n + 1),
    validatedAddressEvidenceReference: id(n + 2),
    addressFingerprint: "a".repeat(64),
    geocodeEvidenceReference: id(n + 3),
    maskedAddress: "12•• Main St · Unit ••",
    contactEvidenceReference: id(n + 4),
    maskedContact: "•••-•••-0199",
    instructionEvidenceReference: id(n + 5),
    requestedWindow: {
      type: "Scheduled",
      startUtc: instant(20),
      endUtc: instant(30),
      storeTimeZone: "America/Toronto",
    },
    confirmedWindow: {
      type: "Scheduled",
      startUtc: instant(25),
      endUtc: instant(35),
      storeTimeZone: "America/Toronto",
    },
    capacityAllocationReference: id(n + 6),
    feeQuoteReference: id(n + 7),
    taxQuoteReference: id(n + 8),
    deliveryVerificationMethodReference: id(n + 9),
    acceptedAt: instant(10),
  });
const detail = () =>
  createDeliveryDetail({
    taskReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    storeReference: id(4),
    snapshot: snapshot(),
  });
const evidence = (overrides: Record<string, unknown> = {}) => ({
  addressValidated: true,
  serviceAreaEligible: true,
  etaAccepted: true,
  pricingAccepted: true,
  capacityAccepted: true,
  orderAmendmentAccepted: true,
  providerAccepted: false,
  managerAuthorized: false,
  hardBlocked: false,
  evidenceReferences: [id(40)],
  ...overrides,
});
describe("Delivery Detail revision", () => {
  it("keeps original and current immutable snapshot evidence", () => {
    expect(detail()).toMatchObject({
      originalSnapshot: { maskedAddress: "12•• Main St · Unit ••" },
      currentSnapshot: { snapshotReference: id(10) },
      aggregateVersion: 1,
    });
  });
  it("accepts a fully revalidated critical revision before cutoff", () => {
    const revised = reviseDeliverySnapshot(detail(), {
      expectedVersion: 1,
      revisionReference: id(30),
      kind: "Critical",
      reasonCode: "ADDRESS_CORRECTION",
      actorReference: id(31),
      requestedAt: instant(12),
      revisionCutoff: instant(19),
      operationalPhase: "Planned",
      proposedSnapshot: snapshot(50),
      validation: evidence(),
    });
    expect(revised.currentSnapshot.snapshotReference).toBe(id(50));
    expect(revised.revisions[0]).toMatchObject({ outcome: "Accepted", version: 1 });
    expect(revised.originalSnapshot.snapshotReference).toBe(id(10));
  });
  it("records a rejected critical revision without replacing the effective snapshot", () => {
    const revised = reviseDeliverySnapshot(detail(), {
      expectedVersion: 1,
      revisionReference: id(30),
      kind: "Critical",
      reasonCode: "WINDOW_CHANGE",
      actorReference: id(31),
      requestedAt: instant(12),
      revisionCutoff: instant(19),
      operationalPhase: "Ready",
      proposedSnapshot: snapshot(50),
      validation: evidence({ capacityAccepted: false }),
    });
    expect(revised.currentSnapshot.snapshotReference).toBe(id(10));
    expect(revised.revisions[0]).toMatchObject({
      outcome: "Rejected",
      rejectionCode: "PROOF_REQUIRED",
    });
  });
  it("requires Manager and Provider acceptance for in-progress critical change", () => {
    expect(
      reviseDeliverySnapshot(detail(), {
        expectedVersion: 1,
        revisionReference: id(30),
        kind: "Critical",
        reasonCode: "ADDRESS_CORRECTION",
        actorReference: id(31),
        requestedAt: instant(12),
        revisionCutoff: instant(19),
        operationalPhase: "InProgress",
        proposedSnapshot: snapshot(50),
        validation: evidence(),
      }).revisions[0]?.outcome,
    ).toBe("Rejected");
  });
  it("rejects terminal, stale-version and cutoff revisions", () => {
    const base = {
      expectedVersion: 1,
      revisionReference: id(30),
      kind: "Ordinary" as const,
      reasonCode: "CONTACT_CORRECTION",
      actorReference: id(31),
      requestedAt: instant(19),
      revisionCutoff: instant(19),
      operationalPhase: "Completed" as const,
      proposedSnapshot: snapshot(50),
      validation: evidence(),
    };
    expect(() => reviseDeliverySnapshot(detail(), base)).toThrow();
    expect(() => reviseDeliverySnapshot(detail(), { ...base, expectedVersion: 2 })).toThrow();
  });
});
