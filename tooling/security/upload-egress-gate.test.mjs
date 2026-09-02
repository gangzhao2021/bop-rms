import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  inspectUpload,
  loadUploadEgressPolicy,
  validateOutboundHop,
  validateSignedDownload,
} from "./upload-egress-gate.mjs";

describe("WP-2054 upload and egress gate", () => {
  it("accepts a bounded clean raster and rejects spoofed, polyglot and oversized content", () => {
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("safe")]);
    expect(
      inspectUpload({
        declaredType: "image/png",
        bytes: png,
        byteSize: png.length,
        pixels: 100,
        malwareClean: true,
      }).ok,
    ).toBe(true);
    const bad = inspectUpload({
      declaredType: "image/png",
      bytes: Buffer.from("<svg><script>"),
      byteSize: 20_000_000,
      pixels: 30_000_000,
      malwareClean: false,
    });
    expect(bad.errors).toEqual(
      expect.arrayContaining([
        "CONTENT_SIGNATURE",
        "ACTIVE_OR_POLYGLOT_CONTENT",
        "SIZE_LIMIT",
        "PIXEL_LIMIT",
        "MALWARE_QUARANTINE",
      ]),
    );
  });

  it("requires fresh bounded private attachment download evidence", () => {
    expect(
      validateSignedDownload({
        freshAuthorization: true,
        ttlSeconds: 300,
        filename: "download",
        disposition: "attachment",
        privateObject: true,
        cloudFrontCacheable: false,
        telemetryCaptured: false,
        referrerExposed: false,
      }).ok,
    ).toBe(true);
    expect(
      validateSignedDownload({
        freshAuthorization: false,
        ttlSeconds: 301,
        filename: "customer-name.pdf",
        disposition: "inline",
        privateObject: false,
        cloudFrontCacheable: true,
        telemetryCaptured: true,
        referrerExposed: true,
      }).ok,
    ).toBe(false);
  });

  it("revalidates every HTTPS DNS/redirect hop and blocks credentials and private addresses", () => {
    expect(
      validateOutboundHop({
        url: "https://sns.ca-central-1.amazonaws.com/cert.pem",
        approvedHost: "sns.ca-central-1.amazonaws.com",
        resolvedAddresses: ["52.95.1.1"],
      }).ok,
    ).toBe(true);
    const rebound = validateOutboundHop({
      url: "https://sns.ca-central-1.amazonaws.com/cert.pem",
      approvedHost: "sns.ca-central-1.amazonaws.com",
      resolvedAddresses: ["169.254.169.254"],
      inboundHeaders: { Authorization: "redacted" },
    });
    expect(rebound.errors).toEqual(
      expect.arrayContaining(["DNS_ADDRESS", "CREDENTIAL_FORWARDING"]),
    );
    expect(
      validateOutboundHop({
        url: "http://127.0.0.1/latest",
        approvedHost: "sns.ca-central-1.amazonaws.com",
        resolvedAddresses: ["127.0.0.1"],
      }).ok,
    ).toBe(false);
  });

  it("keeps real S3, GuardDuty and firewall facts as External Evidence", async () => {
    const policy = await loadUploadEgressPolicy();
    expect(policy.externalEvidenceRequired).toBe(true);
    expect(policy.remoteBusinessContentImport).toBe(false);
  });
});
