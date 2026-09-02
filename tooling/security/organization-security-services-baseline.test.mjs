import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/organization-security-services-baseline.json";

describe("WP-2061 organization security services baseline", () => {
  it("pins the accepted organization services in the security account", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.delegatedAdministratorAccount).toBe("security-log-archive");
    expect(policy.organizationServices).toEqual([
      "aws-config",
      "cloudtrail",
      "guardduty",
      "iam-access-analyzer",
      "security-hub",
    ]);
    expect(policy.configAggregatorRequired).toBe(true);
  });

  it("requires an encrypted immutable archive outside workload administration", async () => {
    const { centralArchive } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(centralArchive).toEqual({
      account: "security-log-archive",
      encrypted: true,
      bucketVersioning: true,
      objectLock: true,
      cloudTrailLogFileValidation: true,
      workloadAdministratorCanAlterDestinationOrRetention: false,
    });
  });

  it("pins every accepted centralized log source", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.requiredLogSources).toEqual([
      "cloudtrail-organization-management-events",
      "cloudtrail-required-kms-data-events",
      "cloudtrail-required-s3-data-events",
      "vpc-flow-logs",
      "waf-logs",
    ]);
    expect(new Set(policy.requiredLogSources).size).toBe(policy.requiredLogSources.length);
  });

  it("fails closed when external or cross-account findings are not pageable", async () => {
    const { findingEscalation } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(findingEscalation).toEqual({
      externalAccess: "page-security-owner",
      crossAccountAccess: "page-security-owner",
      unknownOrDeliveryFailure: "fail-closed",
    });
  });

  it("contains no account identity, credential, finding payload or claimed production pass", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(/\b\d{12}\b|arn:aws|accessKeyId|secretAccessKey/iu);
    expect(source).not.toMatch(/customer|actor|email|ipAddress|findingPayload/iu);
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
    expect(JSON.parse(source).externalEvidenceRequired).toBe(true);
  });
});
