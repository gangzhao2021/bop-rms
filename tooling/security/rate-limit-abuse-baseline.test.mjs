import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { describe, expect, it } from "vitest";

const baselineUrl = new URL("../../docs/security/rate-limit-abuse-baseline.json", import.meta.url);
const expectedBudgets = {
  "public-read": "120/1m/IP;600/1m/Store;burst=30",
  "qr-resolve": "60/5m/IP;600/5m/Store;burst=20",
  "guest-session-create-rotate": "20/10m/IP;300/10m/Store",
  "dine-in-join-failures": "5/10m/Session;20/10m/IP-device",
  "cart-quote": "60/1m/GuestSession;300/1m/IP",
  "checkout-order-payment": "10/10m/GuestSession;50/10m/IP",
  "order-resume": "5/1h/Order-contact-IP",
  "pickup-proof-failures": "5/10m/Fulfillment;20/10m/device-IP",
  "merchant-login-failures": "10/15m/Account-IP-risk",
  "signed-provider-webhook": "size-signature-timestamp-account-backpressure",
};

describe("WP-2042 rate-limit and abuse baseline", () => {
  it("pins every accepted default without claiming enforcement", async () => {
    const baseline = JSON.parse(await readFile(baselineUrl, "utf8"));
    expect(baseline).toMatchObject({
      schemaVersion: 1,
      decision: "IDR-0031",
      rawBucketRetentionHours: 24,
      securityCaseRetentionDays: 365,
      identifierClassification: "Confidential",
      loweringPolicy: "Security approval and expiring risk record required",
      enforcement: {
        coarse: "AWS WAF owns IP/path burst control",
        atomic: "PostgreSQL security.abuse_bucket owns scoped time buckets in WP-2048",
        advisoryOnly: "in-memory counters",
        redis: "disabled",
      },
    });
    expect(
      Object.fromEntries(baseline.endpointClasses.map(({ id, budget }) => [id, budget])),
    ).toEqual(expectedBudgets);
    expect(new Set(baseline.endpointClasses.map(({ id }) => id)).size).toBe(10);
    expect(
      baseline.endpointClasses
        .filter(({ id }) => id !== "public-read" && id !== "signed-provider-webhook")
        .every(({ dependencyFailure }) => dependencyFailure === "fail-closed"),
    ).toBe(true);
  });
});
