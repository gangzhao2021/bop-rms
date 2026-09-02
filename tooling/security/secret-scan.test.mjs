import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const maximumTrackedFileBytes = 2 * 1024 * 1024;
const patterns = [
  ["aws-access-key", new RegExp(`A${"KIA"}[0-9A-Z]{16}`, "u")],
  ["github-token", new RegExp(`g${"h[pousr]"}_[A-Za-z0-9]{30,}`, "u")],
  ["stripe-live-secret", new RegExp(`s${"k_live_"}[A-Za-z0-9]{16,}`, "u")],
  ["private-key", new RegExp(`-${"----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"}`, "u")],
];

function findings(text) {
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

describe("WP-2044 tracked-file secret scan", () => {
  it("detects every supported high-confidence canary", () => {
    const canaries = [
      `A${"KIA"}${"A".repeat(16)}`,
      `g${"hp_"}${"a".repeat(36)}`,
      `s${"k_live_"}${"b".repeat(24)}`,
      `-${"----BEGIN PRIVATE KEY-----"}`,
    ];
    expect(canaries.flatMap(findings)).toEqual([
      "aws-access-key",
      "github-token",
      "stripe-live-secret",
      "private-key",
    ]);
  });

  it("finds no high-confidence secret in the exact tracked tree", async () => {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: process.cwd(),
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    });
    const files = stdout.toString("utf8").split("\0").filter(Boolean);
    expect(files).not.toContain("BOP-RMS Complete Handoff Package.md");
    const matches = [];
    for (const file of files) {
      const metadata = await stat(file);
      if (metadata.size > maximumTrackedFileBytes)
        throw new Error(`tracked file exceeds secret-scan bound: ${file}`);
      const content = await readFile(file);
      if (content.includes(0)) continue;
      for (const finding of findings(content.toString("utf8"))) matches.push(`${file}:${finding}`);
    }
    expect(matches).toEqual([]);
  });
});
