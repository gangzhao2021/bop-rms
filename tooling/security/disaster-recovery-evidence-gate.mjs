import { readFile } from "node:fs/promises";
import process from "node:process";
import { URL, pathToFileURL } from "node:url";

const policyPath = new URL(
  "../../docs/security/disaster-recovery-evidence-policy.json",
  import.meta.url,
);
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const utcPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

const exactKeys = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");

const exactStringSet = (value, expected) =>
  Array.isArray(value) &&
  value.every((item) => typeof item === "string") &&
  value.length === expected.length &&
  [...value].sort().join("\n") === [...expected].sort().join("\n");

const pushIf = (errors, condition, code) => {
  if (condition) errors.push(code);
};

export async function loadDisasterRecoveryPolicy() {
  return JSON.parse(await readFile(policyPath, "utf8"));
}

export async function validateDisasterRecoveryEvidence(evidence) {
  const policy = await loadDisasterRecoveryPolicy();
  const errors = [];
  pushIf(
    errors,
    !exactKeys(evidence, [
      "schemaVersion",
      "accountSupport",
      "database",
      "replica",
      "objectReplication",
      "failover",
      "restore",
      "reconciliation",
      "route53",
      "drills",
    ]),
    "EVIDENCE_SHAPE",
  );
  pushIf(errors, evidence?.schemaVersion !== policy.schemaVersion, "SCHEMA_VERSION");

  const support = evidence?.accountSupport;
  pushIf(
    errors,
    !exactKeys(support, ["engineVersionSupported", "servicesSupported", "evidenceDigest"]) ||
      support?.engineVersionSupported !== true ||
      support?.servicesSupported !== true ||
      !digestPattern.test(support?.evidenceDigest ?? ""),
    "ACCOUNT_SUPPORT",
  );

  const database = evidence?.database;
  pushIf(
    errors,
    !exactKeys(database, [
      "primaryRegion",
      "recoveryRegion",
      "multiAz",
      "encrypted",
      "pitr",
      "crossRegionAutomatedBackup",
      "primaryRetentionDays",
      "recoveryRetentionDays",
    ]) ||
      database?.primaryRegion !== policy.primaryRegion ||
      database?.recoveryRegion !== policy.recoveryRegion ||
      database?.multiAz !== true ||
      database?.encrypted !== true ||
      database?.pitr !== true ||
      database?.crossRegionAutomatedBackup !== true ||
      database?.primaryRetentionDays !== policy.productionRetentionDays ||
      database?.recoveryRetentionDays !== policy.productionRetentionDays,
    "DATABASE_RECOVERY_PROFILE",
  );

  const replica = evidence?.replica;
  pushIf(
    errors,
    !exactKeys(replica, [
      "encrypted",
      "readOnlyUntilPromotion",
      "observedMaximumLagSeconds",
      "alertThresholdSeconds",
      "pageThresholdSeconds",
    ]) ||
      replica?.encrypted !== true ||
      replica?.readOnlyUntilPromotion !== true ||
      !Number.isInteger(replica?.observedMaximumLagSeconds) ||
      replica?.observedMaximumLagSeconds < 0 ||
      replica?.observedMaximumLagSeconds > policy.transactionRpoMinutes * 60 ||
      replica?.alertThresholdSeconds !== policy.replicaLagAlertMinutes * 60 ||
      replica?.pageThresholdSeconds !== policy.replicaLagPageMinutes * 60,
    "REPLICA_RPO",
  );

  const objectReplication = evidence?.objectReplication;
  pushIf(
    errors,
    !exactKeys(objectReplication, [
      "s3Versioned",
      "s3CrossRegion",
      "ecrCrossRegion",
      "destinationPrepared",
      "unnecessaryPiiCopied",
    ]) ||
      objectReplication?.s3Versioned !== true ||
      objectReplication?.s3CrossRegion !== true ||
      objectReplication?.ecrCrossRegion !== true ||
      objectReplication?.destinationPrepared !== true ||
      objectReplication?.unnecessaryPiiCopied !== false,
    "OBJECT_REPLICATION",
  );

  const failover = evidence?.failover;
  pushIf(
    errors,
    !exactKeys(failover, [
      "primaryWritesFenced",
      "lastConfirmedPositionRecorded",
      "destinationPromoted",
      "applicationEndpointRotated",
      "migrationEndpointRotated",
      "splitBrainPrevented",
      "idempotencyKeysStable",
    ]) ||
      failover?.primaryWritesFenced !== true ||
      failover?.lastConfirmedPositionRecorded !== true ||
      failover?.destinationPromoted !== true ||
      failover?.applicationEndpointRotated !== true ||
      failover?.migrationEndpointRotated !== true ||
      failover?.splitBrainPrevented !== true ||
      failover?.idempotencyKeysStable !== true,
    "FAILOVER_FENCING",
  );

  const restore = evidence?.restore;
  pushIf(
    errors,
    !exactKeys(restore, [
      "trafficFenced",
      "recoveredData",
      "projectionRebuilt",
      "cacheRebuilt",
      "checks",
      "isolatedRestore",
      "destructionEvidenceDigest",
    ]) ||
      restore?.trafficFenced !== true ||
      !exactStringSet(restore?.recoveredData, policy.requiredRecoveredData) ||
      restore?.projectionRebuilt !== true ||
      restore?.cacheRebuilt !== true ||
      !exactStringSet(restore?.checks, policy.requiredRestoreChecks) ||
      restore?.isolatedRestore !== true ||
      !digestPattern.test(restore?.destructionEvidenceDigest ?? ""),
    "RESTORE_SAFETY",
  );

  const reconciliation = evidence?.reconciliation;
  pushIf(
    errors,
    !exactKeys(reconciliation, [
      "completedAdapters",
      "unknownOperationsRetriedAfterReconciliation",
    ]) ||
      !exactStringSet(reconciliation?.completedAdapters, policy.requiredReconciliations) ||
      reconciliation?.unknownOperationsRetriedAfterReconciliation !== true,
    "PROVIDER_RECONCILIATION",
  );

  const route53 = evidence?.route53;
  pushIf(
    errors,
    !exactKeys(route53, [
      "lowTtlRecorded",
      "healthEvidenceDigest",
      "namedManualAuthority",
      "communicationsRecorded",
      "rollbackCriteriaRecorded",
      "failForwardCriteriaRecorded",
    ]) ||
      route53?.lowTtlRecorded !== true ||
      !digestPattern.test(route53?.healthEvidenceDigest ?? "") ||
      route53?.namedManualAuthority !== true ||
      route53?.communicationsRecorded !== true ||
      route53?.rollbackCriteriaRecorded !== true ||
      route53?.failForwardCriteriaRecorded !== true,
    "ROUTE53_CONTROL",
  );

  const drills = evidence?.drills;
  pushIf(
    errors,
    !exactKeys(drills, [
      "quarterlyRestoreCompletedAt",
      "semiannualFailoverCompletedAt",
      "measuredRpoSeconds",
      "measuredRtoSeconds",
      "evidenceDigest",
    ]) ||
      !utcPattern.test(drills?.quarterlyRestoreCompletedAt ?? "") ||
      !utcPattern.test(drills?.semiannualFailoverCompletedAt ?? "") ||
      !Number.isInteger(drills?.measuredRpoSeconds) ||
      drills?.measuredRpoSeconds < 0 ||
      drills?.measuredRpoSeconds > policy.transactionRpoMinutes * 60 ||
      !Number.isInteger(drills?.measuredRtoSeconds) ||
      drills?.measuredRtoSeconds < 0 ||
      drills?.measuredRtoSeconds > policy.transactionRtoMinutes * 60 ||
      !digestPattern.test(drills?.evidenceDigest ?? ""),
    "DRILL_OBJECTIVES",
  );

  return { ok: errors.length === 0, errors: [...new Set(errors)].sort() };
}

async function main() {
  const evidencePath = process.argv[2];
  if (!evidencePath) {
    process.stderr.write(
      "EXTERNAL_EVIDENCE_REQUIRED: pass a disaster-recovery evidence JSON file\n",
    );
    process.exitCode = 2;
    return;
  }
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const result = await validateDisasterRecoveryEvidence(evidence);
  if (!result.ok) {
    process.stderr.write(`${result.errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
