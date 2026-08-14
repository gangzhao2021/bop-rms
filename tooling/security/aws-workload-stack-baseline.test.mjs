import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/aws-workload-stack-baseline.json";

describe("WP-2063 AWS workload stack baseline", () => {
  it("pins the accepted CDK toolchain and isolated environments", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.toolchain).toEqual({ awsCdk: "2.261.0", constructs: "10.7.0" });
    expect(policy.environments).toEqual(["development", "staging", "production"]);
    expect(policy.externalEvidenceRequired).toBe(true);
  });

  it("pins a two-AZ production network with private compute and isolated database", async () => {
    const { network } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(network.productionAvailabilityZonesMinimum).toBeGreaterThanOrEqual(2);
    expect(network.publicSubnetResources).toEqual(["alb", "required-managed-edge"]);
    expect(network).toMatchObject({
      ecsSubnet: "private",
      rdsSubnet: "isolated-database",
      rdsPublicEndpoint: false,
      ecsPublicAddress: false,
    });
  });

  it("pins hardened ECS capacity and encrypted recoverable RDS", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.ecs).toMatchObject({
      productionApiBffTasksMinimum: 2,
      productionWorkerTasksMinimum: 2,
      readOnlyRootFilesystem: true,
      dropLinuxCapabilities: true,
      boundedEphemeralTmp: true,
      ecsExec: false,
      ssh: false,
      publicDebugEndpoint: false,
    });
    expect(policy.rds).toEqual({
      engine: "postgresql-18.4",
      encrypted: true,
      multiAzProduction: true,
      pitr: true,
      maximumApplicationConnectionBudgetPercent: 70,
    });
  });

  it("pins private S3, separated keys and no plaintext secret", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(Object.values(policy.s3).filter((value) => value === false)).toEqual([false]);
    expect(policy.s3.acls).toBe(false);
    expect(policy.kmsAndSecrets).toEqual({
      productionSeparatedFromDevelopment: true,
      secretsManager: true,
      plaintextEnvironmentSecret: false,
    });
  });

  it("requires endpoints, firewalled allowlisted egress and separate least-privilege roles", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.vpcEndpoints).toEqual(["cloudwatch-logs", "ecr", "kms", "s3", "secrets-manager"]);
    expect(policy.remainingInternetEgress).toEqual({
      path: "multi-az-nat-and-network-firewall",
      statefulSniAndHttpHostAllowlist: true,
      centralFlowAndAlertLogs: true,
      unregisteredDestination: "deny",
    });
    expect(policy.taskRoles).toEqual(["api-bff", "worker", "migration", "operational-break-glass"]);
    expect(policy.sharedIamUserKey).toBe(false);
    expect(policy.applicationRootUse).toBe(false);
  });

  it("contains no account identity, ARN, endpoint, credential or claimed production pass", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(/https?:\/\/|\b\d{12}\b|arn:aws|accessKeyId|secretAccessKey/iu);
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
  });
});
