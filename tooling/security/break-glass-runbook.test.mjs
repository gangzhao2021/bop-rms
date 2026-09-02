import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const runbookPath = "docs/runbooks/break-glass-access.md";
const templatePath = "docs/runbooks/break-glass-access-evidence-template.md";

describe("WP-2046 break-glass access runbook", () => {
  it("pins the fail-closed, two-person, time-bound lifecycle", async () => {
    const runbook = await readFile(runbookPath, "utf8");
    const required = [
      "## Mandatory hard stops",
      "## Roles and separation of duties",
      "## Phase 1 — Request and read-only preflight",
      "## Phase 2 — Two-person approval and issuance",
      "## Phase 3 — Bounded execution and monitoring",
      "## Phase 4 — Immediate revocation and verification",
      "## Phase 5 — Review and closure",
      "distinct active Actor",
      "recent MFA",
      "finite UTC start/expiry",
      "purpose-built least-privilege",
      "Expiry is not extendable in place",
      "approved restricted evidence system, never Git",
    ];

    for (const item of required) expect(runbook).toContain(item);
    expect(runbook).toContain("Opening this file does not authorize access");
    expect(runbook).toMatch(
      /does not prove\s+that a real Actor, account, role, alert, drill or revocation exists/,
    );
  });

  it("keeps a complete unfilled external-evidence record", async () => {
    const template = await readFile(templatePath, "utf8");
    for (const item of [
      "Separation-of-duties review",
      "Recent TOTP MFA review",
      "Approved UTC start/expiry",
      "Central Audit/provider logging active",
      "Temporary grant/task/recovery path removed",
      "Exceptional capability absent after revocation",
      "Independent reviewer decision safe reference",
      "Two distinct trained active Actors were observed",
    ]) {
      expect(template).toContain(item);
    }

    expect(template).toContain("<required external evidence>");
    expect(template).toContain("<pass/fail/blocked>");
    expect(template).not.toMatch(/\b(PASS|PASSED)\b/);
  });
});
