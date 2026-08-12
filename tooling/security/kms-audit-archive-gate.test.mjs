import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/kms-audit-archive-evidence-policy.json";

describe("WP-2052 KMS, audit and archive external-evidence gate", () => {
  it("pins every accepted production control without claiming it locally", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.schemaVersion).toBe(1);
    expect(policy.requiredControls).toHaveLength(24);
    expect(new Set(policy.requiredControls).size).toBe(policy.requiredControls.length);
    expect(policy.requiredControls).toContain("minimum-30-day-key-deletion-window");
    expect(policy.requiredControls).toContain(
      "pepper-maximum-24-hour-overlap-or-global-revocation",
    );
    expect(policy.requiredControls).toContain("quarterly-cross-tenant-safe-restore-sample");
    expect(policy.externalEvidenceRequired).toBe(true);
  });

  it("contains no credential, provider identity or claimed pass result", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(/(?:arn:aws|BEGIN PRIVATE KEY|secretAccessKey|accessKeyId)/u);
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
  });
});
