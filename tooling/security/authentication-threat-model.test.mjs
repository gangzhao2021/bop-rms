import { readFile } from "node:fs/promises";
import { URL } from "node:url";

import { describe, expect, it } from "vitest";

const modelUrl = new URL("../../docs/security/authentication-threat-model.md", import.meta.url);
const requiredHeadings = [
  "## Security objectives",
  "## Actors and dependencies",
  "## Assets and data classification",
  "## Data flows and trust boundaries",
  "## Threat register",
  "## Abuse and failure invariants",
  "## Verification and release gates",
  "## Residual risk and review triggers",
];
const requiredThreats = Array.from(
  { length: 16 },
  (_, index) => `TM-AUTH-${String(index + 1).padStart(2, "0")}`,
);

describe("WP-2040 authentication threat model", () => {
  it("retains the complete reviewed register and keeps external evidence gated", async () => {
    const model = await readFile(modelUrl, "utf8");
    for (const heading of requiredHeadings) expect(model).toContain(heading);

    const rows = model.split("\n").filter((line) => /^\| TM-AUTH-\d{2} \|/u.test(line));
    expect(rows).toHaveLength(requiredThreats.length);
    expect(new Set(rows.map((row) => row.split("|")[1]?.trim()))).toEqual(new Set(requiredThreats));
    for (const row of rows) {
      expect(row.split("|")).toHaveLength(8);
      expect(row).toMatch(/(controlled|External gate)/u);
    }

    for (const phrase of [
      "Cognito Plus",
      "Threat Protection",
      "WAF",
      "KMS",
      "Secrets Manager",
      "penetration",
      "External Evidence — unavailable and unclaimed",
      "keeps production authentication disabled",
    ])
      expect(model).toContain(phrase);

    expect(model).not.toMatch(/External Evidence[^\n]*(?:PASS|Passed|Available)/u);
    expect(model).not.toMatch(/(?:real|production) (?:credential|token|secret)\s*[:=]/iu);
  });
});
