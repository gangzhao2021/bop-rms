import { describe, expect, it } from "vitest";
import { loadReleaseEvidencePolicy, validateReleaseEvidence } from "./release-evidence-gate.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

async function fixture() {
  const policy = await loadReleaseEvidencePolicy();
  const resultDigest = digest("b");
  return {
    schemaVersion: 1,
    trust: {
      sourceCommit: "a".repeat(40),
      workflowIdentity: "synthetic/wp-2050-test@refs/heads/main",
      builderIdentity: "synthetic-buildkit-test",
      protectedRef: true,
      untrustedPullRequest: false,
    },
    image: {
      baseImage: "node:24.18.0-bookworm-slim",
      baseDigest: digest("a"),
      resultDigest,
      platform: "linux/amd64",
    },
    runtime: {
      user: "node",
      sourceControlMetadata: false,
      packageManagerCache: false,
      developmentDependencies: false,
      readOnlyRootFilesystem: true,
      linuxCapabilitiesDropped: true,
      boundedEphemeralTmp: true,
      publicSourceMaps: false,
    },
    tools: policy.requiredToolPins.map((name, index) => ({
      name,
      immutablePin: digest(((index + 1) % 10).toString()),
      reviewReference: `synthetic-review-${index + 1}`,
    })),
    artifacts: policy.requiredArtifacts.map((name, index) => ({
      name,
      status: "PASS",
      subjectDigest: resultDigest,
      evidenceDigest: digest(((index + 1) % 10).toString()),
    })),
    findings: { exploitableCritical: 0, exploitableHigh: 0 },
    signing: {
      status: "PASS",
      subjectDigest: resultDigest,
      kmsAsymmetric: true,
      keyAlgorithm: "ECC_NIST_P256",
      signatureAlgorithm: "ECDSA_SHA_256",
    },
    registry: { tagImmutable: true, enhancedScanning: true },
    promotion: { stagingDigest: resultDigest, productionDigest: resultDigest },
  };
}

describe("WP-2050 release evidence gate", () => {
  it("accepts a complete synthetic digest-bound evidence bundle", async () => {
    expect(await validateReleaseEvidence(await fixture())).toEqual({ ok: true, errors: [] });
  });

  it("fails closed on untrusted builds, mutable tool pins and digest rebuilds", async () => {
    const evidence = await fixture();
    evidence.trust.untrustedPullRequest = true;
    evidence.tools[0].immutablePin = "v1";
    evidence.promotion.productionDigest = digest("f");
    const result = await validateReleaseEvidence(evidence);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("UNTRUSTED_BUILD");
    expect(result.errors).toContain("TOOL_PIN_BUILDKIT");
    expect(result.errors).toContain("DIGEST_PROMOTION");
  });

  it("fails closed on missing evidence, exploitable findings and invalid signing", async () => {
    const evidence = await fixture();
    evidence.artifacts.pop();
    evidence.findings.exploitableHigh = 1;
    evidence.signing.status = "FAIL";
    const result = await validateReleaseEvidence(evidence);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("ARTIFACT_THIRD_PARTY_NOTICES");
    expect(result.errors).toContain("EXPLOITABLE_FINDING");
    expect(result.errors).toContain("SIGNATURE");
  });

  it("keeps actual release production as an explicit external-evidence gate", async () => {
    const policy = await loadReleaseEvidencePolicy();
    expect(policy.externalEvidenceRequired).toBe(true);
  });
});
