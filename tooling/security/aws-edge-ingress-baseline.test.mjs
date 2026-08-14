import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyPath = "docs/security/aws-edge-ingress-baseline.json";

describe("WP-2062 AWS edge and ingress baseline", () => {
  it("pins DNS, certificate and registrar launch gates without inventing a hostname", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.dnsAndCertificate.services).toEqual(["route53", "acm"]);
    expect(policy.dnsAndCertificate.domainEvidenceRequired).toBe(true);
    expect(policy.dnsAndCertificate.registrarControls).toHaveLength(6);
  });

  it("pins the accepted regional ALB transport and request boundary", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.regionalAlbOrigins).toEqual(["customer", "merchant", "integrations"]);
    expect(policy.alb).toEqual({
      tlsPolicy: "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09",
      httpAction: "fixed-https-redirect",
      deletionProtection: true,
      desyncMitigationMode: "strictest",
      dropInvalidHeaders: true,
      idleTimeoutSeconds: 120,
      forwardedChainMode: "append",
      rejectUnknownHost: true,
    });
  });

  it("limits CloudFront to a private-OAC public asset origin", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.publicAssetCloudFront).toMatchObject({
      minimumTls: "TLSv1.2_2021",
      origin: "private-s3-oac",
      forwardCookie: false,
      forwardAuthorization: false,
      forwardUserSpecificQuery: false,
      cors: "exact-customer-and-merchant-origins",
    });
    expect(policy.publicAssetCloudFront.allowedContent).toEqual([
      "content-hashed-non-pii-image",
      "public-brand-asset",
    ]);
  });

  it("keeps public APIs and every private or provider class out of CloudFront", async () => {
    const policy = JSON.parse(await readFile(policyPath, "utf8"));
    expect(policy.cloudFrontDeniedClasses).toEqual([
      "api-v1-public",
      "guest-session",
      "merchant-private",
      "provider-result",
      "receipt",
      "support",
      "transaction",
    ]);
    expect(policy.integrationsOrigin).toEqual({ browserCookie: false, cors: false, cache: false });
  });

  it("requires staged WAF enforcement and preserves provider signature verification", async () => {
    const { waf } = JSON.parse(await readFile(policyPath, "utf8"));
    expect(waf.managedRuleGroups).toEqual([
      "core",
      "known-bad-inputs",
      "sql-database",
      "amazon-ip-reputation",
    ]);
    expect(waf.changeSequence).toEqual(["staging-count", "replay-review", "block"]);
    expect(waf.exclusionRequirements).toEqual(["path-and-rule-scoped", "owned", "expiring"]);
    expect(waf.mayReplaceProviderSignatureVerification).toBe(false);
  });

  it("contains no hostname, account identity, credential or claimed production pass", async () => {
    const source = await readFile(policyPath, "utf8");
    expect(source).not.toMatch(/https?:\/\/|\b\d{12}\b|arn:aws|accessKeyId|secretAccessKey/iu);
    expect(source).not.toMatch(/"status"\s*:\s*"PASS"/u);
    expect(JSON.parse(source).externalEvidenceRequired).toBe(true);
  });
});
