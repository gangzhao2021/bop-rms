import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/release-deployment-pipeline-baseline.json";

describe("WP-2064 release deployment pipeline baseline", () => {
  it("pins a claim-scoped GitHub OIDC boundary without long-lived AWS credentials", async () => {
    const { githubOidc } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(githubOidc.longLivedAwsCredential).toBe(false);
    expect(githubOidc.trustClaims).toHaveLength(5);
    expect(githubOidc.forkOrPullRequestCanAssumeDeploymentRole).toBe(false);
    expect(githubOidc.productionEnvironmentApprovalRequired).toBe(true);
  });

  it("requires immutable scanned ECR digest promotion", async () => {
    const { ecr } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(ecr).toEqual({
      tagImmutable: true,
      enhancedScanning: true,
      deployByDigestOnly: true,
      sameDigestStagingAndProduction: true,
    });
  });

  it("pins the accepted CodeDeploy ECS canary and automatic rollback", async () => {
    const { blueGreen } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(blueGreen).toEqual({
      provider: "codedeploy-ecs",
      targetGroups: 2,
      healthAlarmsRequired: true,
      canaryTrafficPercent: 10,
      canaryObservationMinutesMinimum: 10,
      automaticRollbackToPriorHealthyDigest: true,
    });
  });

  it("pins a dedicated one-shot expand-to-contract migration workflow", async () => {
    const { migration } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(migration.sequence).toEqual([
      "expand",
      "backfill",
      "dual-compatible-application",
      "verify",
      "contract",
    ]);
    expect(migration).toMatchObject({
      oneShotTask: true,
      dedicatedRole: true,
      backupAndRecoveryCheck: true,
      advisoryLock: true,
      applicationAutoMigrate: false,
      contractWaitsObservationWindow: true,
      restoreOrCompensationPathRequired: true,
    });
  });

  it("pins fail-readiness startup and bounded recoverable shutdown", async () => {
    const { runtime } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(runtime.shutdownSequence).toEqual([
      "fail-readiness",
      "stop-new-work",
      "drain-bounded-leases",
      "exit",
    ]);
    expect(runtime.startupConfigurationSchemaValidated).toBe(true);
    expect(runtime.missingOrUnknownProductionConfigurationFailsReadiness).toBe(true);
    expect(runtime.livenessSeparatedFromReadiness).toBe(true);
    expect(runtime.abandonedLeaseRecoverable).toBe(true);
  });

  it("contains no repository identity, role ARN, credential, digest or claimed production pass", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(
      /https?:\/\/|\b[0-9a-f]{40}\b|sha256:|arn:aws|accessKeyId|secretAccessKey/iu,
    );
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
    expect(JSON.parse(source).externalEvidenceRequired).toBe(true);
  });
});
