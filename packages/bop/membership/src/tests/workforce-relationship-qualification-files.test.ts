import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workforceRelationshipQualificationSigningBytes } from "../contracts/workforce-relationship-qualification.js";
import {
  createFileCurrentWorkforceRelationshipSource,
  type FileCurrentWorkforceRelationshipSourceOptions,
  type WorkforceRelationshipQualificationAuthority,
  type WorkforceRelationshipQualificationTransaction,
} from "../infrastructure/workforce-relationship-qualification-files.js";

const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-06T12:00:00.000Z",
  deadline = "2026-10-06T12:00:05.000Z";
const expected = {
  environmentReference: id(1),
  actorReference: id(2),
  brandReference: id(3),
  workforceRelationshipReference: id(4),
  relationshipEvidenceReference: id(5),
};
const denied = { code: "WORKFORCE_RELATIONSHIP_QUALIFICATION_UNAVAILABLE" };
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bop-workforce-qualification-"));
  directories.push(directory);
  const qualificationPath = join(directory, "qualification.json"),
    trustPath = join(directory, "trust.json");
  // Ephemeral synthetic external issuer keys; no production or plan-approval key.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  let statement = {
      profile: "WorkforceRelationshipQualificationV1",
      purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
      ...expected,
      issuerReference: id(6),
      keyReference: id(7),
      revision: 1,
      status: "Current",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
      effectiveUntil: "2027-01-01T00:00:00.000Z" as string | null,
      verifiedAt: "2026-10-06T11:00:00.000Z",
      validUntil: "2026-10-06T13:00:00.000Z",
      signature: "A".repeat(86),
    },
    key = {
      keyReference: id(7),
      issuerReference: id(6),
      environmentReference: id(1),
      purposeCode: "WORKFORCE_RELATIONSHIP_QUALIFICATION",
      brandReferences: [id(3)],
      notBefore: "2026-01-01T00:00:00.000Z",
      validUntil: "2027-01-01T00:00:00.000Z",
      publicKeySpki: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    },
    withdrawn: string[] = [],
    time = at,
    allowed = true,
    limit = deadline,
    authorityPatch: Record<string, unknown> = {},
    authorityHook: (() => Promise<void>) | undefined;
  const writeStatement = async (patch: Record<string, unknown> = {}, signed = true) => {
    statement = { ...statement, ...patch };
    if (signed)
      statement.signature = sign(
        null,
        Buffer.from(workforceRelationshipQualificationSigningBytes(statement), "utf8"),
        privateKey,
      ).toString("base64url");
    await writeFile(qualificationPath, JSON.stringify(statement), { mode: 0o600 });
  };
  const writeTrust = async (patch: Record<string, unknown> = {}) => {
    key = { ...key, ...patch };
    await writeFile(
      trustPath,
      JSON.stringify({
        profile: "WorkforceRelationshipQualificationTrustV1",
        keys: [key],
        withdrawnEvidenceReferences: withdrawn,
      }),
      { mode: 0o600 },
    );
  };
  await writeStatement();
  await writeTrust();
  const tx: WorkforceRelationshipQualificationTransaction = {
    query: vi.fn(async () => ({ rows: [] })),
  };
  let guard: (() => Promise<void>) | undefined,
    final: (() => void) | undefined,
    registrations = 0;
  const options = {
    transaction: tx,
    expected: { ...expected },
    qualificationPath,
    trustPath,
    clock: { now: () => time },
    originalObservedAt: at,
    originalValidUntil: deadline,
    authority: {
      hold: vi.fn(
        async (
          actual: WorkforceRelationshipQualificationTransaction,
          input: WorkforceRelationshipQualificationAuthority,
        ): Promise<WorkforceRelationshipQualificationAuthority> => {
          expect(actual).toBe(tx);
          await authorityHook?.();
          if (!allowed) throw new Error("controlled private authority failure");
          return {
            ...input,
            validUntil: limit < input.validUntil ? limit : input.validUntil,
            ...authorityPatch,
          };
        },
      ),
    },
    registerBeforeCommit: async (
      actual: WorkforceRelationshipQualificationTransaction,
      g: () => Promise<void>,
      f: () => void,
    ) => {
      expect(actual).toBe(tx);
      registrations++;
      guard = g;
      final = f;
    },
  } satisfies FileCurrentWorkforceRelationshipSourceOptions;
  const source = createFileCurrentWorkforceRelationshipSource(options);
  return {
    source,
    options,
    tx,
    directory,
    qualificationPath,
    trustPath,
    writeStatement,
    writeTrust,
    setTime: (value: string) => {
      time = value;
    },
    setLimit: (value: string) => {
      limit = value;
    },
    withdrawAuthority: () => {
      allowed = false;
    },
    patchAuthority: (value: Record<string, unknown>) => {
      authorityPatch = value;
    },
    onAuthority: (hook: () => Promise<void>) => {
      authorityHook = hook;
    },
    async withdrawEvidence() {
      withdrawn = [id(5)];
      await writeTrust();
    },
    registrations: () => registrations,
    async guard() {
      if (!guard) throw new Error("missing host guard");
      await guard();
    },
    final() {
      if (!final) throw new Error("missing host final seal");
      final();
    },
  };
}

describe("current external Workforce relationship qualification files", () => {
  it("verifies actual Ed25519 files and returns minimized facts through one actual host", async () => {
    const f = await fixture();
    expect(await f.source.hold()).toEqual({
      profile: "CurrentWorkforceRelationshipQualificationV1",
      ...expected,
      issuerReference: id(6),
      revision: 1,
      relationshipEffectiveFrom: "2026-01-01T00:00:00.000Z",
      relationshipEffectiveUntil: "2027-01-01T00:00:00.000Z",
      verifiedAt: "2026-10-06T11:00:00.000Z",
      observedAt: at,
      validUntil: deadline,
    });
    expect(f.tx.query).not.toHaveBeenCalled();
    await f.guard();
    f.final();
    f.options.clock.now = () => {
      throw new Error("post-COMMIT clock read");
    };
    await rm(f.qualificationPath);
    await rm(f.trustPath);
    expect(() => f.source.assertFinalized()).not.toThrow();
  });

  it("reuses the holder before and after the host async guard without extending its original lease", async () => {
    const f = await fixture();
    await f.source.hold();
    f.setTime("2026-10-06T12:00:01.000Z");
    f.setLimit("2026-10-06T12:00:04.000Z");
    const second = await f.source.hold();
    expect(second.observedAt).toBe(at);
    expect(second.validUntil).toBe("2026-10-06T12:00:04.000Z");
    await f.guard();
    f.setLimit(deadline);
    expect((await f.source.hold()).validUntil).toBe(second.validUntil);
    expect(f.registrations()).toBe(1);
    f.final();
    f.source.assertFinalized();
  });

  it("accepts explicit ongoing business validity and exact private read-only files", async () => {
    const f = await fixture();
    await f.writeStatement({ effectiveUntil: null });
    await chmod(f.qualificationPath, 0o400);
    await chmod(f.trustPath, 0o400);
    expect((await f.source.hold()).relationshipEffectiveUntil).toBeNull();
    await f.guard();
    f.final();
  });

  it.each([
    "environmentReference",
    "actorReference",
    "brandReference",
    "workforceRelationshipReference",
    "relationshipEvidenceReference",
  ])("rejects genuinely signed statements bound to another %s", async (field) => {
    const f = await fixture();
    await f.writeStatement({ [field]: id(80) });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });

  it.each([
    { issuerReference: id(80) },
    { keyReference: id(80) },
    { status: "Withdrawn" },
    { effectiveFrom: "2026-10-06T12:00:00.001Z" },
    { effectiveUntil: at },
    { verifiedAt: "2026-10-06T12:00:00.001Z" },
    { validUntil: at },
  ])("rejects signed but ineligible evidence: %j", async (patch) => {
    const f = await fixture();
    await f.writeStatement(patch);
    await expect(f.source.hold()).rejects.toMatchObject(denied);
  });

  it.each([
    { issuerReference: id(80) },
    { environmentReference: id(80) },
    { brandReferences: [id(80)] },
    { purposeCode: "BRAND_INITIAL_PROVISIONING" },
    { notBefore: "2026-10-06T11:00:00.001Z" },
    { validUntil: at },
  ])(
    "requires separate current key trust for exact issuer/environment/Brand: %j",
    async (patch) => {
      const f = await fixture();
      await f.writeTrust(patch);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    },
  );

  it("rejects tampering, another signer's public key and malformed SPKI using actual crypto", async () => {
    const tampered = await fixture();
    await tampered.writeStatement({ revision: 2 }, false);
    await expect(tampered.source.hold()).rejects.toMatchObject(denied);
    const other = await fixture(),
      pair = generateKeyPairSync("ed25519");
    await other.writeTrust({
      publicKeySpki: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    });
    await expect(other.source.hold()).rejects.toMatchObject(denied);
    const malformed = await fixture();
    await malformed.writeTrust({ publicKeySpki: "A".repeat(59) });
    await expect(malformed.source.hold()).rejects.toMatchObject(denied);
    const unsupported = await fixture(),
      x25519 = generateKeyPairSync("x25519");
    await unsupported.writeTrust({
      publicKeySpki: x25519.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    });
    await expect(unsupported.source.hold()).rejects.toMatchObject(denied);
  });

  it("does not accept a signature from another protocol domain", async () => {
    const f = await fixture(),
      other = generateKeyPairSync("ed25519");
    const statement = JSON.parse(await readFile(f.qualificationPath, "utf8"));
    statement.signature = sign(
      null,
      Buffer.from(
        workforceRelationshipQualificationSigningBytes(statement).replace(
          "WorkforceRelationshipQualificationV1\n",
          "BrandInitialProvisioningApprovalV1\n",
        ),
      ),
      other.privateKey,
    ).toString("base64url");
    await writeFile(f.qualificationPath, JSON.stringify(statement));
    await f.writeTrust({
      publicKeySpki: other.publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
  });

  it.each(["statement", "key", "withdrawal", "authority"])(
    "rereads current %s and prevents caught late failures from committing",
    async (kind) => {
      const f = await fixture();
      await f.source.hold();
      if (kind === "statement") await f.writeStatement({ revision: 2 });
      if (kind === "key") await f.writeTrust({ validUntil: "2027-02-01T00:00:00.000Z" });
      if (kind === "withdrawal") await f.withdrawEvidence();
      if (kind === "authority") f.withdrawAuthority();
      await expect(f.guard()).rejects.toMatchObject(denied);
      expect(() => f.final()).toThrow();
      expect(() => f.source.assertFinalized()).toThrow();
    },
  );

  it.each(["statement", "key", "business"])(
    "caps the authorization lease by actual %s expiry",
    async (kind) => {
      const f = await fixture(),
        expires = "2026-10-06T12:00:03.000Z";
      if (kind === "statement") await f.writeStatement({ validUntil: expires });
      if (kind === "key") await f.writeTrust({ validUntil: expires });
      if (kind === "business") await f.writeStatement({ effectiveUntil: expires });
      expect((await f.source.hold()).validUntil).toBe(expires);
      await f.guard();
      f.setTime(expires);
      expect(() => f.final()).toThrow();
    },
  );

  for (const target of ["qualification", "trust"] as const) {
    it(`refuses non-private or executable ${target} modes`, async () => {
      // The current macOS host normalizes chmod(04600) to 0600. Exercise
      // observable unsupported modes rather than claiming a setuid fixture.
      for (const mode of [0o640, 0o644, 0o700, 0o200]) {
        const f = await fixture();
        const file = target === "qualification" ? f.qualificationPath : f.trustPath;
        await chmod(file, mode);
        expect((await stat(file)).mode & 0o7777).toBe(mode);
        await expect(f.source.hold()).rejects.toMatchObject(denied);
      }
    });
    it(`refuses symbolic and hard links for ${target}`, async () => {
      for (const symbolic of [true, false]) {
        const f = await fixture(),
          file = target === "qualification" ? f.qualificationPath : f.trustPath;
        if (symbolic) {
          const bytes = await readFile(file);
          await rm(file);
          await writeFile(`${file}.target`, bytes, { mode: 0o600 });
          await symlink(`${file}.target`, file);
        } else await link(file, `${file}.linked`);
        await expect(f.source.hold()).rejects.toMatchObject(denied);
      }
    });
  }

  it.each([
    Buffer.alloc(65_537, 0x20),
    Buffer.alloc(0),
    Buffer.from([0xff]),
    Buffer.from('{"incomplete":'),
  ])("refuses bounded-file/UTF-8/JSON failures without leaking bytes", async (bytes) => {
    const f = await fixture();
    await writeFile(f.qualificationPath, bytes);
    await expect(f.source.hold()).rejects.toMatchObject({
      ...denied,
      message: "Workforce relationship qualification is unavailable",
    });
  });

  it("refuses missing or nonregular files with a generic error", async () => {
    for (const directory of [false, true]) {
      const f = await fixture();
      await rm(f.qualificationPath);
      if (directory) await mkdir(f.qualificationPath);
      await expect(f.source.hold()).rejects.toMatchObject({
        ...denied,
        message: "Workforce relationship qualification is unavailable",
      });
    }
  });

  it("requires closed exact authority and refuses withdrawal after a successful read", async () => {
    for (const patch of [
      { expected: { ...expected, actorReference: id(90) } },
      { observedAt: "2026-10-06T11:59:59.999Z" },
      { validUntil: "2026-10-06T12:00:05.001Z" },
      { allowed: true },
    ]) {
      const f = await fixture();
      f.patchAuthority(patch);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    }
    const f = await fixture();
    let calls = 0;
    f.onAuthority(async () => {
      if (++calls === 2) f.withdrawAuthority();
    });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(calls).toBe(2);
  });

  it("poisons caught reentry and caught premature final assertions", async () => {
    const f = await fixture();
    let called = false;
    f.onAuthority(async () => {
      if (called) return;
      called = true;
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    await expect(f.guard()).rejects.toMatchObject(denied);
    const early = await fixture();
    await early.source.hold();
    expect(() => early.source.assertFinalized()).toThrow();
    await expect(early.guard()).rejects.toMatchObject(denied);
    expect(() => early.final()).toThrow();
  });

  it("registers before failure, expires after awaited authority, and refuses malformed final clocks", async () => {
    const early = await fixture();
    early.setTime(deadline);
    await expect(early.source.hold()).rejects.toMatchObject(denied);
    expect(early.registrations()).toBe(1);
    await expect(early.guard()).rejects.toMatchObject(denied);
    const late = await fixture();
    late.onAuthority(async () => {
      late.setTime(deadline);
    });
    await expect(late.source.hold()).rejects.toMatchObject(denied);
    for (const time of [deadline, "2026-10-06T11:59:59.999Z", "not-time"]) {
      const f = await fixture();
      await f.source.hold();
      await f.guard();
      f.setTime(time);
      expect(() => f.final()).toThrow();
      expect(() => f.source.assertFinalized()).toThrow();
    }
  });

  it.each([
    "transaction",
    "query",
    "clock",
    "authority",
    "registration",
    "expected",
    "path",
    "deadline",
  ])("refuses captured %s drift", async (part) => {
    const f = await fixture();
    await f.source.hold();
    if (part === "transaction") f.options.transaction = { query: f.tx.query };
    if (part === "query") f.tx.query = async () => ({ rows: [] });
    if (part === "clock") f.options.clock.now = () => at;
    if (part === "authority")
      f.options.authority.hold = vi.fn(async () => {
        throw new Error("replacement invoked");
      });
    if (part === "registration") f.options.registerBeforeCommit = async () => undefined;
    if (part === "expected") f.options.expected.actorReference = id(90);
    if (part === "path") f.options.qualificationPath = f.trustPath;
    if (part === "deadline") f.options.originalValidUntil = "2026-10-06T12:00:04.000Z";
    await expect(f.guard()).rejects.toMatchObject(denied);
  });

  it("requires one real host guard and seal, and rejects duplicate or premature seals", async () => {
    const early = await fixture();
    await early.source.hold();
    expect(() => early.final()).toThrow();
    await expect(early.guard()).rejects.toMatchObject(denied);
    const repeated = await fixture();
    await repeated.source.hold();
    await repeated.guard();
    await expect(repeated.guard()).rejects.toMatchObject(denied);
    expect(() => repeated.final()).toThrow();
    const final = await fixture();
    await final.source.hold();
    await final.guard();
    final.final();
    expect(() => final.final()).toThrow();
    expect(() => final.source.assertFinalized()).toThrow();
  });

  it("rejects unsafe configuration and never evaluates closed option getters", async () => {
    const f = await fixture();
    for (const qualificationPath of [
      "relative.json",
      `${f.directory}/../qualification.json`,
      f.trustPath,
      "\0",
    ])
      expect(() =>
        createFileCurrentWorkforceRelationshipSource({ ...f.options, qualificationPath }),
      ).toThrow();
    expect(() =>
      createFileCurrentWorkforceRelationshipSource({
        ...f.options,
        originalValidUntil: "2026-10-06T12:00:05.001Z",
      }),
    ).toThrow();
    const getter = vi.fn(() => f.qualificationPath);
    expect(() =>
      createFileCurrentWorkforceRelationshipSource(
        Object.defineProperty({ ...f.options }, "qualificationPath", {
          enumerable: true,
          get: getter,
        }),
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});
