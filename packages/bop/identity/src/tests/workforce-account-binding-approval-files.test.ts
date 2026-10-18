import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { chmod, link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileWorkforceAccountBindingApprovalSource,
  workforceAccountBindingApprovalSigningBytes,
  type WorkforceAccountBindingApprovalExpected,
  type WorkforceAccountBindingApprovalTransaction,
} from "../infrastructure/workforce-account-binding-approval-files.js";

const id = (n: number) => `0190ed60-0040-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "workforce-binding-approval-"));
  directories.push(dir);
  const approvalPath = path.join(dir, "approval.json"),
    trustPath = path.join(dir, "trust.json"),
    keys = generateKeyPairSync("ed25519");
  const expected: WorkforceAccountBindingApprovalExpected = {
    configuration: {
      environment: "internal-test",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Synthetic",
      clientIds: ["merchant"],
    },
    operationReference: id(1),
    actorReference: id(2),
    intentDigest: "sha256:" + "a".repeat(64),
    operatorReference: id(3),
    approvedByReference: id(4),
    approvalEvidenceReference: id(5),
  };
  const content = {
    profile: "WorkforceAccountBindingApprovalV1",
    purposeCode: "WORKFORCE_ACCOUNT_BINDING",
    ...expected,
    keyReference: id(6),
    notBefore: "2026-10-06T11:00:00.000Z",
    validUntil: "2026-10-06T13:00:00.000Z",
    signature: "A".repeat(86),
  };
  const trustKey = {
    keyReference: id(6),
    approvedByReference: expected.approvedByReference,
    configuration: expected.configuration,
    purposeCode: "WORKFORCE_ACCOUNT_BINDING",
    notBefore: content.notBefore,
    validUntil: content.validUntil,
    publicKeySpki: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
  const trust = {
    profile: "WorkforceAccountBindingTrustV1",
    keys: [trustKey],
    withdrawnApprovalEvidenceReferences: [] as string[],
  };
  async function writeApproval(patch: Record<string, unknown> = {}) {
    const packet = { ...content, ...patch };
    const signed = {
      ...packet,
      signature: sign(
        null,
        Buffer.from(workforceAccountBindingApprovalSigningBytes(packet)),
        keys.privateKey,
      ).toString("base64url"),
    };
    await writeFile(approvalPath, JSON.stringify(signed), { mode: 0o600 });
    return signed;
  }
  async function writeTrust(patch: Record<string, unknown> = {}) {
    await writeFile(trustPath, JSON.stringify({ ...trust, ...patch }), { mode: 0o600 });
  }
  await writeApproval();
  await writeTrust();
  let time = at,
    calls = 0,
    guard: (() => Promise<void>) | undefined,
    final: (() => void) | undefined;
  const tx = {
    async query() {
      throw Error("approval must not query SQL");
    },
  };
  const options = {
    transaction: tx,
    approvalPath,
    trustPath,
    clock: { now: () => time },
    originalObservedAt: at,
    originalValidUntil: until,
    async registerBeforeCommit(
      actual: WorkforceAccountBindingApprovalTransaction,
      g: () => Promise<void>,
      f: () => void,
    ) {
      expect(actual).toBe(tx);
      calls++;
      guard = g;
      final = f;
    },
  };
  const source = createFileWorkforceAccountBindingApprovalSource(options);
  return {
    source,
    options,
    expected,
    content,
    trust,
    trustKey,
    keys,
    approvalPath,
    trustPath,
    writeApproval,
    writeTrust,
    setTime: (v: string) => {
      time = v;
    },
    guard: async () => {
      expect(guard).toBeTypeOf("function");
      if (!guard) throw Error("missing guard");
      await guard();
    },
    final: () => {
      expect(final).toBeTypeOf("function");
      if (!final) throw Error("missing final");
      final();
    },
    calls: () => calls,
  };
}
const denied = { message: "WORKFORCE_ACCOUNT_BINDING_APPROVAL_UNAVAILABLE" };
describe("independent Workforce account binding approval files", () => {
  it("verifies real Ed25519, reuses the holder and seals only before commit", async () => {
    const f = await fixture();
    expect(await f.source.hold(f.expected)).toEqual({
      operatorReference: id(3),
      approvedByReference: id(4),
      approvalEvidenceReference: id(5),
      validUntil: until,
    });
    f.setTime("2026-10-06T12:00:01.000Z");
    expect((await f.source.hold(f.expected)).validUntil).toBe(until);
    expect(f.calls()).toBe(1);
    await f.guard();
    await f.source.hold(f.expected);
    f.final();
    await rm(f.approvalPath);
    f.setTime("2026-10-06T13:00:00.000Z");
    expect(() => f.source.assertFinalized()).not.toThrow();
  });
  it.each([
    "operationReference",
    "actorReference",
    "operatorReference",
    "approvedByReference",
    "approvalEvidenceReference",
  ])("binds signed %s", async (key) => {
    const f = await fixture();
    await f.writeApproval({ [key]: id(20) });
    await expect(f.source.hold(f.expected)).rejects.toMatchObject(denied);
  });
  it.each(["environment", "issuer", "clientIds"])("binds signed configuration %s", async (key) => {
    const f = await fixture();
    const changes = {
      environment: "other",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Other",
      clientIds: ["other"],
    };
    await f.writeApproval({
      configuration: { ...f.expected.configuration, [key]: changes[key as keyof typeof changes] },
    });
    await expect(f.source.hold(f.expected)).rejects.toMatchObject(denied);
  });
  it("binds complete intent and rejects unknown or authentication/role claims", async () => {
    const f = await fixture();
    await f.writeApproval({ intentDigest: "sha256:" + "b".repeat(64) });
    await expect(f.source.hold(f.expected)).rejects.toMatchObject(denied);
    for (const key of ["subject", "authenticatedAt", "role", "brandReference"])
      expect(() =>
        workforceAccountBindingApprovalSigningBytes({ ...f.content, [key]: "invented" }),
      ).toThrow();
  });
  it.each(["tamper", "otherKey", "otherProtocol", "x25519"])(
    "rejects invalid cryptographic evidence %s",
    async (kind) => {
      const f = await fixture(),
        packet = JSON.parse(await readFile(f.approvalPath, "utf8"));
      if (kind === "tamper") packet.signature = "A".repeat(86);
      if (kind === "otherKey")
        packet.signature = sign(
          null,
          Buffer.from(workforceAccountBindingApprovalSigningBytes(packet)),
          generateKeyPairSync("ed25519").privateKey,
        ).toString("base64url");
      if (kind === "otherProtocol")
        packet.signature = sign(
          null,
          Buffer.from("AnotherPurpose\n" + workforceAccountBindingApprovalSigningBytes(packet)),
          f.keys.privateKey,
        ).toString("base64url");
      if (kind === "x25519")
        await f.writeTrust({
          keys: [
            {
              ...f.trustKey,
              publicKeySpki: generateKeyPairSync("x25519")
                .publicKey.export({ type: "spki", format: "der" })
                .toString("base64url"),
            },
          ],
        });
      await writeFile(f.approvalPath, JSON.stringify(packet));
      await expect(f.source.hold(f.expected)).rejects.toMatchObject(denied);
    },
  );
  it.each(["removedKey", "wrongApprover", "wrongScope", "withdrawal", "purpose"])(
    "requires current independent trust %s",
    async (kind) => {
      const f = await fixture();
      await f.source.hold(f.expected);
      if (kind === "removedKey") await f.writeTrust({ keys: [] });
      if (kind === "wrongApprover")
        await f.writeTrust({ keys: [{ ...f.trustKey, approvedByReference: id(88) }] });
      if (kind === "wrongScope")
        await f.writeTrust({
          keys: [
            { ...f.trustKey, configuration: { ...f.expected.configuration, environment: "other" } },
          ],
        });
      if (kind === "withdrawal")
        await f.writeTrust({ withdrawnApprovalEvidenceReferences: [id(5)] });
      if (kind === "purpose")
        await f.writeTrust({
          keys: [{ ...f.trustKey, purposeCode: "BRAND_INITIAL_PROVISIONING" }],
        });
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
    },
  );
  it.each(["approval", "key"])("preserves shorter %s expiry", async (kind) => {
    const f = await fixture(),
      shorter = "2026-10-06T12:00:02.000Z";
    if (kind === "approval") await f.writeApproval({ validUntil: shorter });
    else await f.writeTrust({ keys: [{ ...f.trustKey, validUntil: shorter }] });
    expect((await f.source.hold(f.expected)).validUntil).toBe(shorter);
    await f.guard();
    f.setTime(shorter);
    expect(() => f.final()).toThrow();
  });
  it("pins an already observed approval instead of accepting a changed valid signature", async () => {
    const f = await fixture();
    await f.source.hold(f.expected);
    await f.writeApproval({ validUntil: "2026-10-06T13:01:00.000Z" });
    await expect(f.guard()).rejects.toMatchObject(denied);
  });
  it.each(["future", "expired", "selfApproval", "malformedTime"])(
    "rejects invalid approval %s",
    async (kind) => {
      const f = await fixture();
      if (kind === "future") await f.writeApproval({ notBefore: "2026-10-06T12:00:00.001Z" });
      if (kind === "expired") await f.writeApproval({ validUntil: at });
      if (kind === "selfApproval")
        await writeFile(
          f.approvalPath,
          JSON.stringify({ ...f.content, approvedByReference: id(3) }),
        );
      if (kind === "malformedTime")
        await writeFile(
          f.approvalPath,
          JSON.stringify({ ...f.content, notBefore: "0000-01-01T00:00:00.000Z" }),
        );
      await expect(f.source.hold(f.expected)).rejects.toMatchObject(denied);
    },
  );
  it.each(["approval", "trust"])("rejects unsafe %s files", async (target) => {
    for (const kind of ["mode", "symlink", "hardlink", "oversize", "utf8", "missing"]) {
      const f = await fixture(),
        file = target === "approval" ? f.approvalPath : f.trustPath;
      if (kind === "mode") await chmod(file, 0o644);
      if (kind === "symlink") {
        const bytes = await readFile(file);
        await rm(file);
        await writeFile(file + ".original", bytes, { mode: 0o600 });
        await symlink(file + ".original", file);
      }
      if (kind === "hardlink") await link(file, file + ".other");
      if (kind === "oversize") await writeFile(file, "x".repeat(65_537));
      if (kind === "utf8") await writeFile(file, Buffer.from([0xff]));
      if (kind === "missing") await rm(file);
      await expect(f.source.hold(f.expected)).rejects.toMatchObject(denied);
    }
  });
  it.each(["query", "clock", "path", "register", "reverseTime", "deadline", "binding"])(
    "poisons changed holder %s",
    async (kind) => {
      const f = await fixture();
      await f.source.hold(f.expected);
      if (kind === "query")
        f.options.transaction.query = async () => {
          throw Error("changed");
        };
      if (kind === "clock") f.options.clock.now = () => at;
      if (kind === "path") f.options.approvalPath += ".changed";
      if (kind === "register") f.options.registerBeforeCommit = async () => undefined;
      if (kind === "reverseTime") f.setTime("2026-10-06T11:59:59.999Z");
      if (kind === "deadline") f.setTime(until);
      if (kind === "binding")
        await expect(
          f.source.hold({ ...f.expected, actorReference: id(99) }),
        ).rejects.toMatchObject(denied);
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
    },
  );
  it.each(["input", "expired"])(
    "registers rollback protection before a caught first %s failure",
    async (kind) => {
      const f = await fixture();
      if (kind === "expired") f.setTime(until);
      const request = kind === "input" ? { ...f.expected, intentDigest: "invalid" } : f.expected;
      await expect(f.source.hold(request)).rejects.toMatchObject(denied);
      expect(f.calls()).toBe(1);
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
    },
  );
  it("poisons a caught premature final assertion", async () => {
    const f = await fixture();
    await f.source.hold(f.expected);
    expect(() => f.source.assertFinalized()).toThrow();
    await expect(f.guard()).rejects.toThrow();
  });
  it("poisons caught reentry during initial guard registration", async () => {
    const f = await fixture();
    const options = {
      ...f.options,
      async registerBeforeCommit() {
        await expect(source.hold(f.expected)).rejects.toMatchObject(denied);
      },
    };
    const source = createFileWorkforceAccountBindingApprovalSource(options);
    await expect(source.hold(f.expected)).rejects.toMatchObject(denied);
  });
});
