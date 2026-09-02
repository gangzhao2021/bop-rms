import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/cloudformation-recovery-evidence-baseline.json";

describe("WP-2066 CloudFormation and recovery evidence baseline", () => {
  it("requires reviewed synth, scan and production change-set approval", async () => {
    const { changeSet } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(Object.values(changeSet).every((value) => value === true)).toBe(true);
  });

  it("turns weekly unexplained drift into an owned exception without auto-reconciliation", async () => {
    const { drift } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(drift).toEqual({
      frequency: "weekly",
      unexplainedChangeAction: "create-owned-expiring-exception",
      automaticReconciliation: false,
      reviewableEvidenceRequired: true,
    });
  });

  it("pins termination and deletion protection for stateful production classes", async () => {
    const { protection } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(protection.productionStackTerminationProtection).toBe(true);
    expect(protection.statefulResourceDeletionProtection).toBe(true);
    expect(protection.protectedClasses).toEqual(["central-log-archive", "kms", "rds", "s3"]);
  });

  it("pins encrypted recovery copies without unnecessary PII propagation", async () => {
    const { backupPolicy } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(backupPolicy.productionRetentionDays).toBe(35);
    expect(backupPolicy).toMatchObject({
      rdsPitr: true,
      rdsMultiAz: true,
      crossRegionAutomatedBackup: true,
      s3VersioningAndCrossRegionReplication: true,
      ecrCrossRegionReplication: true,
      destinationKeysSecretsConfigurationPrepared: true,
      unnecessaryPiiCopied: false,
    });
  });

  it("requires fenced verified cross-account restore and measured drills", async () => {
    const { crossAccountRestore } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(crossAccountRestore.requiredChecks).toEqual([
      "schema",
      "audit-chain",
      "malware-and-object-reference",
      "authorization",
      "privacy-tombstone-reapplication",
    ]);
    expect(crossAccountRestore).toMatchObject({
      isolatedRestore: true,
      customerAndProviderTrafficFenced: true,
      dedicatedRestoreVerifierRole: true,
      providerReconciliationBeforeUnknownRetry: true,
      quarterlyRestoreDrill: true,
      semiannualCrossRegionDrill: true,
      transactionRpoMinutes: 5,
      transactionRtoMinutes: 60,
    });
  });

  it("contains no stack, account, credential, backup identity or claimed production pass", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(/https?:\/\/|\b\d{12}\b|arn:aws|accessKeyId|secretAccessKey/iu);
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
    expect(JSON.parse(source).externalEvidenceRequired).toBe(true);
  });
});
