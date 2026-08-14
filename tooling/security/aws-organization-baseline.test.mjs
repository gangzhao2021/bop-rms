import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/aws-organization-baseline.json";

describe("WP-2060 AWS organization baseline", () => {
  it("pins the accepted isolated account topology", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.accounts).toEqual([
      "management",
      "security-log-archive",
      "development",
      "staging",
      "production",
    ]);
    expect(policy.approvedRegions).toEqual(["ca-central-1", "ca-west-1"]);
    expect(policy.externalEvidenceRequired).toBe(true);
  });

  it("pins every accepted SCP denial without an allow-all escape", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.requiredScpDenials).toHaveLength(9);
    expect(new Set(policy.requiredScpDenials).size).toBe(9);
    expect(policy.requiredScpDenials.join(" ")).not.toMatch(/allow-all|administratoraccess/iu);
  });

  it("defines the fail-closed production evidence contract", async () => {
    const required = [
      "managementHasWorkloads",
      "productionSharesDevelopmentDataOrKeys",
      "identityCenterMfa",
      "maximumHumanSessionHours",
      "longLivedIamUserKeys",
      "memberRootCredentialsRemoved",
      "managementRootAccessKeys",
      "managementRootHardwareMfa",
      "groupControlledRecoveryContacts",
      "emergencyProcedureTested",
      "scpDenials",
      "breakGlassTwoPersonApproved",
      "breakGlassTimeBound",
      "breakGlassCentrallyAlerted",
    ];
    const valid = {
      managementHasWorkloads: false,
      productionSharesDevelopmentDataOrKeys: false,
      identityCenterMfa: true,
      maximumHumanSessionHours: 4,
      longLivedIamUserKeys: false,
      memberRootCredentialsRemoved: true,
      managementRootAccessKeys: false,
      managementRootHardwareMfa: true,
      groupControlledRecoveryContacts: true,
      emergencyProcedureTested: true,
      scpDenials: JSON.parse(await readFile(policyPath, "utf8")).requiredScpDenials,
      breakGlassTwoPersonApproved: true,
      breakGlassTimeBound: true,
      breakGlassCentrallyAlerted: true,
    };
    expect(Object.keys(valid).sort()).toEqual(required.sort());
    expect(valid).toMatchObject({
      managementHasWorkloads: false,
      productionSharesDevelopmentDataOrKeys: false,
      identityCenterMfa: true,
      longLivedIamUserKeys: false,
      managementRootAccessKeys: false,
      managementRootHardwareMfa: true,
    });
    expect(valid.maximumHumanSessionHours).toBeLessThanOrEqual(4);
  });

  it("contains no account identity, credential or claimed production pass", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(/\b\d{12}\b|arn:aws|accessKeyId|secretAccessKey/iu);
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
  });
});
