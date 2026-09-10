import process from "node:process";
import { execFile } from "node:child_process";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const policyPath = "docs/security/privacy-execution-policy.json";

async function policy() {
  return JSON.parse(await readFile(policyPath, "utf8"));
}

async function productionFiles(cwd) {
  const { stdout } = await execFileAsync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "apps/**/*.ts",
      "apps/**/*.tsx",
      "apps/**/*.js",
      "apps/**/*.mjs",
      "packages/**/*.ts",
      "packages/**/*.tsx",
      "packages/**/*.js",
      "packages/**/*.mjs",
    ],
    { cwd },
  );
  return stdout
    .split("\n")
    .filter(Boolean)
    .filter((file) => !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file));
}

function allowedCookie(policy, name, file) {
  return (
    policy.necessaryCookies.some((cookie) => cookie.name === name) ||
    policy.necessaryCookieFamilies.some(
      (family) => family.prefix === name && family.sourceFiles.includes(file),
    )
  );
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

    const files = await productionFiles(process.cwd());
    const trackerPattern =
      /(?:googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|hotjar\.com|fullstory\.com|clarity\.ms|from\s+["'](?:@?segment|mixpanel|amplitude|@fullstory|react-ga))/iu;

    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, `${file} contains a prohibited tracker`).not.toMatch(trackerPattern);
      for (const cookie of source.matchAll(/__Host-bop-[a-z-]+/gu)) {
        expect(
          allowedCookie(value, cookie[0], file),
          `${file} contains unregistered cookie ${cookie[0]}`,
        ).toBe(true);
      }
    }
  });

  it("registers only the operation-scoped candidate families in their exact transport owners", async () => {
    const value = await policy();
    expect(value.necessaryCookieFamilies).toEqual([
      {
        prefix: "__Host-bop-guest-candidate-",
        suffixFormat: "uuid-v7-operation-reference",
        purpose: "guest-binding-candidate-handoff",
        sourceFiles: ["apps/api/src/customer-cart-binding.ts"],
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        domain: null,
        persistence: "browser-session",
        serverAuthority: "Identity preparation and Session deadlines",
        clearOn: "successful activation or completion of the same operation",
        webStorage: false,
      },
      {
        prefix: "__Host-bop-guest-dining-candidate-",
        suffixFormat: "uuid-v7-operation-reference",
        purpose: "guest-dining-binding-candidate-handoff",
        sourceFiles: ["apps/api/src/customer-dining-binding.ts"],
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        domain: null,
        persistence: "browser-session",
        serverAuthority: "Identity preparation and Session deadlines",
        clearOn: "successful activation or completion of the same operation",
        webStorage: false,
      },
    ]);
    expect(
      allowedCookie(value, "__Host-bop-guest-candidate-", "apps/api/src/customer-cart-binding.ts"),
    ).toBe(true);
    expect(allowedCookie(value, "__Host-bop-guest-candidate-", "apps/api/src/other.ts")).toBe(
      false,
    );
    expect(
      allowedCookie(
        value,
        "__Host-bop-guest-candidate-tracking",
        "apps/api/src/customer-cart-binding.ts",
      ),
    ).toBe(false);
    expect(
      allowedCookie(value, "__Host-bop-unregistered", "apps/api/src/customer-cart-binding.ts"),
    ).toBe(false);
  });

  it("rejects Dining candidate use outside its owner and cross-purpose registration", async () => {
    const value = await policy();
    expect(
      allowedCookie(
        value,
        "__Host-bop-guest-dining-candidate-",
        "apps/api/src/customer-dining-binding.ts",
      ),
    ).toBe(true);
    for (const file of ["apps/api/src/customer-cart-binding.ts", "apps/api/src/other.ts"])
      expect(allowedCookie(value, "__Host-bop-guest-dining-candidate-", file)).toBe(false);
    expect(
      allowedCookie(
        value,
        "__Host-bop-guest-candidate-",
        "apps/api/src/customer-dining-binding.ts",
      ),
    ).toBe(false);
    expect(
      allowedCookie(
        value,
        "__Host-bop-guest-dining-candidate-tracking",
        "apps/api/src/customer-dining-binding.ts",
      ),
    ).toBe(false);
  });

  it("includes new production files before commit and excludes ignored/test files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bop-cookie-inventory-"));
    try {
      await execFileAsync("git", ["init", "--quiet", directory]);
      await mkdir(join(directory, "apps/api/src"), { recursive: true });
      await writeFile(join(directory, ".gitignore"), "apps/api/src/ignored.ts\n");
      for (const name of ["new.ts", "ignored.ts", "new.test.ts"])
        await writeFile(join(directory, "apps/api/src", name), "export {};\n");
      expect(await productionFiles(directory)).toEqual(["apps/api/src/new.ts"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
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
