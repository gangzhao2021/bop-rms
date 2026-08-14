import { describe, expect, it } from "vitest";
import {
  loadStatutoryArchivePolicy,
  validateStatutoryArchiveEvidence,
} from "./statutory-archive-gate.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

async function fixture() {
  const policy = await loadStatutoryArchivePolicy();
  return {
    schemaVersion: 1,
    archive: {
      recordClasses: policy.recordClasses,
      snapshotFormats: policy.snapshotFormats,
      excludedFields: policy.excludedFields,
      linkedCorrectionsOnly: true,
      operationalQuerySource: false,
      analyticsFeed: false,
      versioned: true,
      sseKms: true,
      objectLockGovernance: true,
      ordinaryBypassAllowed: false,
    },
    manifest: {
      schemaVersion: 1,
      policyVersion: 1,
      templateVersion: 1,
      businessDateFrom: "2026-01-01",
      businessDateThrough: "2026-12-31",
      fiscalYearEnd: "2026-12-31",
      objectCount: 6,
      sourceHash: digest("a"),
      archiveHash: digest("b"),
    },
    retention: {
      retainUntil: "2033-12-31",
      legalHoldActive: false,
      legalHoldReleaseApproved: true,
      applicationCanShorten: false,
      complianceModeCounselApproved: false,
    },
    access: {
      controls: policy.requiredAccessControls,
      crossTenantAccess: false,
      rawPiiSearch: false,
    },
    verification: {
      sourceCountMatches: true,
      sourceHashMatches: true,
      archivePresent: true,
      manifestSignatureValid: true,
      verifiedAt: "2027-01-01T01:00:00Z",
    },
    restore: {
      quarterlySampleCompletedAt: "2027-04-01T12:00:00Z",
      legalReceiptReconstructed: true,
      transactionHistoryReconstructed: true,
      otherTenantExposed: false,
      trafficFencedUntilTombstones: true,
      tombstone: {
        opaqueSubjectId: "subject:synthetic-1",
        fieldReference: "contact:email",
        policyVersion: 1,
        completedAt: "2027-01-02T12:00:00Z",
        replayStatus: "Applied",
      },
    },
    destruction: {
      requested: true,
      afterRetention: true,
      legalHoldReleased: true,
      manifestEvidenceDigest: digest("c"),
      objectVersionEvidenceDigest: digest("d"),
    },
  };
}

describe("WP-2055 statutory archive evidence gate", () => {
  it("accepts a complete synthetic minimized archive lifecycle", async () => {
    expect(await validateStatutoryArchiveEvidence(await fixture())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("fails closed on PII expansion, replacement semantics and short retention", async () => {
    const evidence = await fixture();
    evidence.archive.excludedFields.pop();
    evidence.archive.linkedCorrectionsOnly = false;
    evidence.retention.retainUntil = "2033-12-30";
    const result = await validateStatutoryArchiveEvidence(evidence);
    expect(result.errors).toEqual(
      expect.arrayContaining(["ARCHIVE_PROFILE", "RETENTION_LEGAL_HOLD"]),
    );
  });

  it("fails closed on hold/deletion conflict and unsafe cross-Tenant restore", async () => {
    const evidence = await fixture();
    evidence.retention.legalHoldActive = true;
    evidence.retention.legalHoldReleaseApproved = true;
    evidence.restore.otherTenantExposed = true;
    evidence.restore.tombstone.replayStatus = "Pending";
    const result = await validateStatutoryArchiveEvidence(evidence);
    expect(result.errors).toEqual(
      expect.arrayContaining(["RETENTION_LEGAL_HOLD", "RESTORE_TOMBSTONE", "DESTRUCTION_GATE"]),
    );
  });

  it("requires exact access and daily verifier evidence", async () => {
    const evidence = await fixture();
    evidence.access.controls = evidence.access.controls.filter((value) => value !== "recent-mfa");
    evidence.verification.manifestSignatureValid = false;
    const result = await validateStatutoryArchiveEvidence(evidence);
    expect(result.errors).toEqual(expect.arrayContaining(["ACCESS_CONTROL", "DAILY_VERIFICATION"]));
  });

  it("keeps counsel, S3 and real restore facts as External Evidence", async () => {
    expect((await loadStatutoryArchivePolicy()).externalEvidenceRequired).toBe(true);
  });
});
