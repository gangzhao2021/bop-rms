import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const policyPath = "docs/security/privacy-execution-policy.json";

async function policy() {
  return JSON.parse(await readFile(policyPath, "utf8"));
}

describe("WP-2051 privacy execution policy", () => {
  it("allows only the three necessary host-only credential cookies", async () => {
    const value = await policy();
    expect(value.necessaryCookies.map(({ name }) => name)).toEqual([
      "__Host-bop-auth",
      "__Host-bop-merchant",
      "__Host-bop-guest",
    ]);
    for (const cookie of value.necessaryCookies) {
      expect(cookie).toMatchObject({
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        domain: null,
      });
    }
  });

  it("finds no unregistered cookie or tracking integration in production source", async () => {
    const value = await policy();
    const allowedCookies = new Set(value.necessaryCookies.map(({ name }) => name));
    const { stdout } = await execFileAsync("git", [
      "ls-files",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "apps/**/*.js",
      "apps/**/*.mjs",
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "packages/**/*.js",
      "packages/**/*.mjs",
    ]);
    const files = stdout
      .split("\n")
      .filter(Boolean)
      .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
    const trackerPattern =
      /(?:googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|hotjar\.com|fullstory\.com|clarity\.ms|from\s+["'](?:@?segment|mixpanel|amplitude|@fullstory|react-ga))/iu;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} contains a prohibited tracker`).not.toMatch(trackerPattern);
      for (const cookie of source.matchAll(/__Host-bop-[a-z-]+/gu)) {
        expect(allowedCookies, `${file} contains unregistered cookie ${cookie[0]}`).toContain(
          cookie[0],
        );
      }
    }
  });

  it("pins the complete privacy-right workflow without erasing required history", async () => {
    const value = await policy();
    expect(value.privacyRights).toEqual({
      types: ["AccessPortability", "Correction", "ConsentWithdrawal", "DeletionAnonymization"],
      trackedRequestRequired: true,
      proportionalIdentityProof: true,
      responseTargetCalendarDays: 30,
      exportEncrypted: true,
      exportSingleUse: true,
      exportMaximumHours: 24,
      unencryptedEmailAttachment: false,
      preserveFinancialAndAuditHistory: true,
      legalHoldOrStatutoryBlockReasonRequired: true,
    });
    expect(value.privacyTombstone.allowedFields).toEqual([
      "opaqueSubjectId",
      "fieldReference",
      "policyVersion",
      "completedAt",
      "replayStatus",
    ]);
    expect(value.privacyTombstone.prohibitedFields).toEqual(["email", "phone", "name"]);
    expect(value.privacyTombstone).toMatchObject({
      productSearch: false,
      analytics: false,
      applyBeforeRestoredTraffic: true,
    });
  });

  it("pins the accepted retention periods and triggers", async () => {
    const value = await policy();
    expect(Object.fromEntries(value.retention.map((item) => [item.class, item.period]))).toEqual({
      "business-record": "P7Y",
      "corporate-permanent-record": "INDEFINITE",
      "unnecessary-customer-contact": "P24M",
      "raw-provider-payload": "P30D",
      "application-log": "P30D",
      "security-audit-archive": "P365D",
      "import-result-artifact": "P90D",
      "development-staging-data": "P7D",
    });
    expect(value.retention.find((item) => item.class === "business-record")?.trigger).toBe(
      "fiscal-year-end",
    );
    expect(
      value.retention.find((item) => item.class === "unnecessary-customer-contact")?.trigger,
    ).toBe("last-closed-transaction");
  });

  it("keeps marketing disabled and production/legal outcomes external", async () => {
    const value = await policy();
    expect(value.marketing.enabled).toBe(false);
    expect(value.prohibitedTracking).toHaveLength(8);
    expect(value.externalEvidenceRequired).toBe(true);
  });
});
