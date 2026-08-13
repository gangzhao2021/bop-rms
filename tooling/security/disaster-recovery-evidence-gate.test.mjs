import { describe, expect, it } from "vitest";
import {
  loadDisasterRecoveryPolicy,
  validateDisasterRecoveryEvidence,
} from "./disaster-recovery-evidence-gate.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

async function fixture() {
  const policy = await loadDisasterRecoveryPolicy();
  return {
    schemaVersion: policy.schemaVersion,
    accountSupport: {
      engineVersionSupported: true,
      servicesSupported: true,
      evidenceDigest: digest("a"),
    },
    database: {
      primaryRegion: policy.primaryRegion,
      recoveryRegion: policy.recoveryRegion,
      multiAz: true,
      encrypted: true,
      pitr: true,
      crossRegionAutomatedBackup: true,
      primaryRetentionDays: policy.productionRetentionDays,
      recoveryRetentionDays: policy.productionRetentionDays,
    },
    replica: {
      encrypted: true,
      readOnlyUntilPromotion: true,
      observedMaximumLagSeconds: 120,
      alertThresholdSeconds: 120,
      pageThresholdSeconds: 300,
    },
    objectReplication: {
      s3Versioned: true,
      s3CrossRegion: true,
      ecrCrossRegion: true,
      destinationPrepared: true,
      unnecessaryPiiCopied: false,
    },
    failover: {
      primaryWritesFenced: true,
      lastConfirmedPositionRecorded: true,
      destinationPromoted: true,
      applicationEndpointRotated: true,
      migrationEndpointRotated: true,
      splitBrainPrevented: true,
      idempotencyKeysStable: true,
    },
    restore: {
      trafficFenced: true,
      recoveredData: policy.requiredRecoveredData,
      projectionRebuilt: true,
      cacheRebuilt: true,
      checks: policy.requiredRestoreChecks,
      isolatedRestore: true,
      destructionEvidenceDigest: digest("b"),
    },
    reconciliation: {
      completedAdapters: policy.requiredReconciliations,
      unknownOperationsRetriedAfterReconciliation: true,
    },
    route53: {
      lowTtlRecorded: true,
      healthEvidenceDigest: digest("c"),
      namedManualAuthority: true,
      communicationsRecorded: true,
      rollbackCriteriaRecorded: true,
      failForwardCriteriaRecorded: true,
    },
    drills: {
      quarterlyRestoreCompletedAt: "2026-08-01T12:00:00Z",
      semiannualFailoverCompletedAt: "2026-08-02T12:00:00Z",
      measuredRpoSeconds: 240,
      measuredRtoSeconds: 3_300,
      evidenceDigest: digest("d"),
    },
  };
}

describe("WP-2053 disaster-recovery evidence gate", () => {
  it("accepts a complete synthetic evidence bundle", async () => {
    expect(await validateDisasterRecoveryEvidence(await fixture())).toEqual({
      ok: true,
      errors: [],
    });
  });

  it("fails closed on unsupported services, excessive lag and split-brain risk", async () => {
    const evidence = await fixture();
    evidence.accountSupport.servicesSupported = false;
    evidence.replica.observedMaximumLagSeconds = 301;
    evidence.failover.primaryWritesFenced = false;
    const result = await validateDisasterRecoveryEvidence(evidence);
    expect(result.errors).toEqual(
      expect.arrayContaining(["ACCOUNT_SUPPORT", "REPLICA_RPO", "FAILOVER_FENCING"]),
    );
  });

  it("fails closed on incomplete recovery, early retry and missed objectives", async () => {
    const evidence = await fixture();
    evidence.restore.checks = evidence.restore.checks.filter(
      (check) => check !== "privacy-tombstone-reapplication",
    );
    evidence.reconciliation.unknownOperationsRetriedAfterReconciliation = false;
    evidence.drills.measuredRtoSeconds = 3_601;
    const result = await validateDisasterRecoveryEvidence(evidence);
    expect(result.errors).toEqual(
      expect.arrayContaining(["RESTORE_SAFETY", "PROVIDER_RECONCILIATION", "DRILL_OBJECTIVES"]),
    );
  });

  it("retains actual AWS resources and drills as External Evidence", async () => {
    const policy = await loadDisasterRecoveryPolicy();
    expect(policy.externalEvidenceRequired).toBe(true);
  });
});
