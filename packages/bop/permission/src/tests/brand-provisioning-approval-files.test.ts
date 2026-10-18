import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeRfc8785 } from "@bop/audit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFileBrandProvisioningApprovalSource } from "../infrastructure/brand-provisioning-approval-files.js";

const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-10-06T12:00:00.000Z";
const expected = Object.freeze({
  environmentReference: id(1),
  operationReference: id(2),
  brandReference: id(3),
  planDigest: `sha256:${"a".repeat(64)}`,
  operatorReference: id(4),
});

describe("private deployment files for signed Brand initialization approval", () => {
  let directory: string;
  let approvalPath: string;
  let trustPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bop-brand-approval-"));
    approvalPath = join(directory, "approval.json");
    trustPath = join(directory, "trust.json");
    // Ephemeral local test keys only; the implementation ships no default key.
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const payload = {
      profile: "BrandInitialProvisioningApprovalV1",
      purposeCode: "BRAND_INITIAL_PROVISIONING",
      ...expected,
      approvedByReference: id(5),
      approvalEvidenceReference: id(6),
      keyReference: id(7),
      notBefore: "2026-10-06T11:00:00.000Z",
      validUntil: "2026-10-06T13:00:00.000Z",
    };
    const signature = sign(
      null,
      Buffer.from(`BOP-RMS:BrandInitialProvisioningApprovalV1\n${canonicalizeRfc8785(payload)}`),
      privateKey,
    ).toString("base64url");
    await writeFile(approvalPath, JSON.stringify({ ...payload, signature }), { mode: 0o600 });
    await writeFile(
      trustPath,
      JSON.stringify({
        profile: "BrandInitialProvisioningTrustV1",
        keys: [
          {
            keyReference: id(7),
            approvedByReference: id(5),
            environmentReference: id(1),
            purposeCode: "BRAND_INITIAL_PROVISIONING",
            notBefore: "2026-10-06T10:00:00.000Z",
            validUntil: "2026-10-06T14:00:00.000Z",
            publicKeySpki: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
          },
        ],
        revokedApprovalEvidenceReferences: [],
      }),
      { mode: 0o600 },
    );
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const source = () =>
    createFileBrandProvisioningApprovalSource({ approvalPath, trustPath, clock: () => now });

  it("verifies actual signed private files and seals the original finite lease", async () => {
    await expect(
      source().withApproval(expected, async (lease) => {
        expect(lease.approval.brandReference).toBe(expected.brandReference);
        expect(lease.validUntil).toBe("2026-10-06T12:00:05.000Z");
        await lease.assertCurrent();
        lease.assertFinalized();
        return "approved";
      }),
    ).resolves.toBe("approved");
  });

  it("reopens the current trust file and observes withdrawal before commit", async () => {
    await expect(
      source().withApproval(expected, async (lease) => {
        const trust = JSON.parse(await readFile(trustPath, "utf8"));
        trust.revokedApprovalEvidenceReferences = [id(6)];
        await writeFile(trustPath, JSON.stringify(trust));
        await lease.assertCurrent();
        lease.assertFinalized();
      }),
    ).rejects.toThrow();
  });

  it("detects approval tampering instead of trusting a cached parsed file", async () => {
    await expect(
      source().withApproval(expected, async (lease) => {
        const approval = JSON.parse(await readFile(approvalPath, "utf8"));
        approval.brandReference = id(99);
        await writeFile(approvalPath, JSON.stringify(approval));
        await lease.assertCurrent();
        lease.assertFinalized();
      }),
    ).rejects.toThrow();
  });

  for (const target of ["approval", "trust"] as const) {
    it(`rejects ${target} files readable by another POSIX principal`, async () => {
      await chmod(target === "approval" ? approvalPath : trustPath, 0o640);
      const work = vi.fn(async () => "must not enter");
      await expect(source().withApproval(expected, work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
    });
    it(`rejects a symlink in the configured ${target} file position`, async () => {
      const path = target === "approval" ? approvalPath : trustPath;
      const bytes = await readFile(path);
      await rm(path);
      await writeFile(`${path}.target`, bytes, { mode: 0o600 });
      await symlink(`${path}.target`, path);
      const work = vi.fn(async () => undefined);
      await expect(source().withApproval(expected, work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
    });
  }

  it("refuses an approval shared through another hard link", async () => {
    await link(approvalPath, join(directory, "approval-copy.json"));
    const work = vi.fn(async () => undefined);
    await expect(source().withApproval(expected, work)).rejects.toThrow();
    expect(work).not.toHaveBeenCalled();
  });

  for (const [description, bytes] of [
    ["oversized", Buffer.alloc(65_537, 0x20)],
    ["empty", Buffer.alloc(0)],
    ["invalid UTF-8", Buffer.from([0xff])],
    ["malformed JSON", Buffer.from('{"privateEvidence":"not-complete')],
  ] as const) {
    it(`refuses ${description} input before invoking business work`, async () => {
      await writeFile(approvalPath, bytes);
      let entered = false;
      await expect(
        source().withApproval(expected, async () => {
          entered = true;
        }),
      ).rejects.toThrow();
      expect(entered).toBe(false);
    });
  }

  it("refuses missing files and directories without leaking their paths or raw filesystem errors", async () => {
    await rm(approvalPath);
    for (const makeDirectory of [false, true]) {
      if (makeDirectory) await mkdir(approvalPath);
      const work = vi.fn(async () => undefined);
      try {
        await source().withApproval(expected, work);
        expect.fail("missing/nonregular approval accepted");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(directory);
        expect((error as Error).message).not.toMatch(/ENOENT|EISDIR/u);
      }
      expect(work).not.toHaveBeenCalled();
    }
  });

  it("requires distinct absolute configured paths and never evaluates option accessors", () => {
    for (const invalid of ["approval.json", `${directory}/../approval.json`, "\0"])
      expect(() =>
        createFileBrandProvisioningApprovalSource({
          approvalPath: invalid,
          trustPath,
          clock: () => now,
        }),
      ).toThrow();
    expect(() =>
      createFileBrandProvisioningApprovalSource({
        approvalPath,
        trustPath: approvalPath,
        clock: () => now,
      }),
    ).toThrow();
    let accessed = false;
    expect(() =>
      createFileBrandProvisioningApprovalSource({
        get approvalPath() {
          accessed = true;
          return approvalPath;
        },
        trustPath,
        clock: () => now,
      }),
    ).toThrow();
    expect(accessed).toBe(false);
  });
});
