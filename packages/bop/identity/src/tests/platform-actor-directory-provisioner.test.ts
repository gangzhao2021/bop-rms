import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  appendPlatformAuditRecordInTransaction,
  canonicalizeRfc8785,
  verifyPlatformAuditChain,
  type PlatformAuditChainRecordV1,
} from "@bop/audit";
import { parseSelectorHash } from "../contracts/browser-session.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import {
  parsePlatformActorDirectoryCommand,
  parsePlatformActorDirectoryConfiguration,
  parsePlatformActorDirectoryRevision,
  type PlatformActorDirectoryCommand,
  type PlatformActorDirectoryRevision,
} from "../contracts/platform-actor-directory.js";
import {
  createPostgresPlatformActorDirectoryProvisioner,
  type PlatformActorDirectoryProvisionerOptions,
} from "../infrastructure/persistence/platform-actor-directory-provisioner.js";
import {
  platformActorDirectoryCodec,
  type PlatformActorDirectoryTransaction,
} from "../infrastructure/persistence/platform-actor-directory-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z",
  deadline = "2026-10-06T12:00:05.000Z",
  subject = "controlled-opaque-subject";
const configuration = parsePlatformActorDirectoryConfiguration({
  environment: "controlled",
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
  clientIds: ["controlledclient"],
});
function initial(): PlatformActorDirectoryCommand {
  return parsePlatformActorDirectoryCommand({
    profile: "PlatformActorDirectoryCommandV1",
    operation: "ImportActive",
    operationReference: id(1),
    actorReference: id(2),
    expectedHead: null,
    subject,
    recordedByReference: id(3),
    approvedByReference: id(4),
    approvalReference: id(5),
    reasonCode: "APPROVED_INVITATION",
  });
}
function lifecycle(
  previous: PlatformActorDirectoryRevision,
  operation: "Suspend" | "Disable" | "Restore",
  op: number,
) {
  return parsePlatformActorDirectoryCommand({
    ...initial(),
    operation,
    operationReference: id(op),
    subject: null,
    expectedHead: {
      revisionReference: previous.revisionReference,
      version: previous.version,
      sourceDigest: previous.sourceDigest,
    },
    reasonCode: "APPROVED_ACCOUNT_CHANGE",
  });
}
function fixture() {
  const key = Buffer.alloc(32, 7),
    hasher: BrowserCredentialHasherPort = {
      hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
      equals: (a, b) => a === b,
    };
  let encryptionCount = 0;
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(text, context) {
      const iv = Buffer.alloc(12, ++encryptionCount),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      const bytes = Buffer.concat([cipher.update(text), cipher.final()]);
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-key",
        ciphertext: Buffer.concat([iv, bytes, cipher.getAuthTag()]).toString("base64url"),
        encryptionContext: context,
      };
    },
    async decrypt(envelope, context) {
      const bytes = Buffer.from(envelope.ciphertext, "base64url"),
        decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
    },
  };
  let time = at,
    controlled = true,
    approved = true,
    enabled = true,
    auditFailure = false,
    allocated = 30,
    actorContext = "",
    targetContext = "",
    current: PlatformActorDirectoryRevision | null = null,
    auditSequence = 1,
    previousHash: string | null = null;
  const originals = new Map<string, PlatformActorDirectoryRevision>(),
    calls: { sql: string; values: readonly unknown[] }[] = [],
    records: PlatformAuditChainRecordV1[] = [],
    sessions = [
      {
        kind: "Platform",
        environment: "controlled",
        actor: id(2),
        status: "Active",
        reason: null as string | null,
      },
      {
        kind: "Workforce",
        environment: "controlled",
        actor: id(2),
        status: "Active",
        reason: null as string | null,
      },
      {
        kind: "Platform",
        environment: "other",
        actor: id(2),
        status: "Active",
        reason: null as string | null,
      },
      {
        kind: "Platform",
        environment: "controlled",
        actor: id(9),
        status: "Active",
        reason: null as string | null,
      },
    ];
  const tx: PlatformActorDirectoryTransaction = {
    async query(sql, values) {
      expect(this).toBe(tx);
      calls.push({ sql, values });
      if (sql.includes("session_user::text"))
        return {
          rows: [
            {
              session_principal: "directory_provisioner",
              current_principal: "directory_provisioner",
              isolation: "read committed",
              controlled,
            },
          ],
        };
      if (sql.includes("set_config('bop.platform_actor_id'")) {
        actorContext = String(values[0]);
        targetContext = String(values[4]);
        return { rows: [] };
      }
      if (sql === "controlled approval changes subject context") {
        targetContext = id(3);
        return { rows: [] };
      }
      if (sql.startsWith("SELECT snapshot_text,source_digest")) {
        const saved = originals.get(String(values[1]));
        return {
          rows: saved
            ? [{ snapshot_text: canonicalizeRfc8785(saved), source_digest: saved.sourceDigest }]
            : [],
        };
      }
      if (sql.startsWith("SELECT r.snapshot_text")) {
        expect(targetContext).toBe(String(values[0]));
        const matching =
          current &&
          current.actorReference === values[0] &&
          current.configuration.issuer === values[1] &&
          current.configuration.environment === values[2];
        return {
          rows: matching
            ? [
                {
                  snapshot_text: canonicalizeRfc8785(current),
                  source_digest: current?.sourceDigest,
                },
              ]
            : [],
        };
      }
      if (sql.startsWith("INSERT INTO bop_identity.platform_actor_directory_revision")) {
        const revision = parsePlatformActorDirectoryRevision(
          JSON.parse(String(values[15])),
          platformActorDirectoryCodec,
        );
        expect(actorContext).toBe(revision.recordedByReference);
        expect(targetContext).toBe(revision.actorReference);
        originals.set(revision.operationReference, revision);
        return { rows: [{ revision_reference: revision.revisionReference }] };
      }
      if (
        sql.startsWith("INSERT INTO bop_identity.platform_actor_directory_head") ||
        sql.startsWith("UPDATE bop_identity.platform_actor_directory_head")
      ) {
        current = [...originals.values()].find((r) => r.revisionReference === values[5]) ?? null;
        return { rows: current ? [{ revision_reference: current.revisionReference }] : [] };
      }
      if (sql.startsWith("UPDATE bop_identity.authentication_session")) {
        expect(sql).toContain("encryption_context=$2||':platform-session:'");
        for (const s of sessions)
          if (
            s.actor === values[0] &&
            s.environment === values[1] &&
            s.kind === "Platform" &&
            s.status === "Active"
          ) {
            s.status = "Revoked";
            s.reason = "Administrative";
          }
        return { rows: [] };
      }
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_chain_head"))
        return { rows: [] };
      if (sql.includes("FROM platform_audit.platform_actor_audit_chain_head"))
        return {
          rows: [
            {
              next_sequence: String(auditSequence),
              previous_hash: previousHash,
              recorded_at: time,
            },
          ],
        };
      if (sql.startsWith("INSERT INTO platform_audit.platform_actor_audit_record")) {
        if (auditFailure) throw new Error("controlled Audit failure");
        expect(values[1]).toBe(id(3));
        expect(actorContext).toBe(id(3));
        return { rows: [{ audit_reference: values[0] }] };
      }
      if (sql.startsWith("UPDATE platform_audit.platform_actor_audit_chain_head")) {
        if (!Buffer.isBuffer(values[2])) throw new Error("controlled hash fixture");
        previousHash = values[2].toString("hex");
        return { rows: [{ next_sequence: String(++auditSequence) }] };
      }
      if (sql === "SET CONSTRAINTS ALL IMMEDIATE") {
        expect(targetContext).toBe(id(2));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
  let guard: (() => Promise<void>) | undefined, final: (() => void) | undefined;
  const options: PlatformActorDirectoryProvisionerOptions = {
    transaction: tx,
    configuration,
    clock: { now: () => time },
    originalObservedAt: at,
    originalValidUntil: deadline,
    hasher,
    envelopes,
    operatorReference: id(3),
    provisioningRoleName: "directory_provisioner",
    authority: {
      async hold(actual, input) {
        expect(actual).toBe(tx);
        if (!approved) throw new Error("controlled approval withdrawn");
        await actual.query("controlled approval changes subject context", []);
        return {
          operatorReference: id(3),
          approvedByReference: input.command.approvedByReference,
          approvalReference: input.command.approvalReference,
          validUntil: deadline,
        };
      },
    },
    nextReference: () => id(++allocated),
    appendAudit: async (actual, input) => {
      const record = await appendPlatformAuditRecordInTransaction(actual, input);
      records.push(record);
      return record;
    },
    readCurrentProviderSubject: async (input) => ({
      ...input,
      status: enabled ? "Enabled" : "Disabled",
      validUntil: deadline,
    }),
    registerBeforeCommit: async (actual, g, f) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  };
  const make = (overrides: Partial<PlatformActorDirectoryProvisionerOptions> = {}) =>
    createPostgresPlatformActorDirectoryProvisioner({ ...options, ...overrides });
  return {
    tx,
    options,
    calls,
    records,
    sessions,
    make,
    current: () => current,
    allocated: () => allocated,
    encryptionCount: () => encryptionCount,
    setTime: (v: string) => {
      time = v;
    },
    deny: () => {
      approved = false;
    },
    disableProvider: () => {
      enabled = false;
    },
    badRole: () => {
      controlled = false;
    },
    failAudit: () => {
      auditFailure = true;
    },
    runGuard: async () => {
      if (!guard) throw new Error("missing guard");
      await guard();
    },
    runFinal: () => {
      if (!final) throw new Error("missing final");
      final();
    },
    finish: async (p: ReturnType<typeof make>) => {
      if (!guard || !final) throw new Error("missing guards");
      await guard();
      final();
      p.assertFinalized();
    },
  };
}
describe("controlled Platform Actor directory provisioner", () => {
  it("stores keyed/encrypted immutable binding and actual operator Audit in the borrowed transaction", async () => {
    const f = fixture(),
      p = f.make(),
      r = await p.provision(initial());
    expect(r.actorReference).toBe(id(2));
    expect(r.recordedByReference).toBe(id(3));
    expect(r.originalCommand).not.toHaveProperty("subject");
    expect(JSON.stringify(f.calls)).not.toContain(subject);
    expect(f.records[0]?.content.actorReference).toBe(id(3));
    expect(f.records[0]?.content.targetReference).toBe(r.revisionReference);
    expect(verifyPlatformAuditChain(f.records)).toBe(true);
    await f.finish(p);
    f.setTime("2026-10-06T13:00:00.000Z");
    p.assertFinalized();
  });
  it("permanently revokes only matching Platform Sessions and Restore cannot revive old sessions", async () => {
    const f = fixture(),
      p = f.make(),
      first = await p.provision(initial());
    await f.finish(p);
    const suspend = f.make(),
      second = await suspend.provision(lifecycle(first, "Suspend", 10));
    await f.finish(suspend);
    expect(f.sessions.map((s) => s.status)).toEqual(["Revoked", "Active", "Active", "Active"]);
    expect(f.sessions[0]?.reason).toBe("Administrative");
    const restore = f.make(),
      third = await restore.provision(lifecycle(second, "Restore", 11));
    await f.finish(restore);
    expect(third.status).toBe("Active");
    expect(third.encryptedSubject).toEqual(first.encryptedSubject);
    expect(f.encryptionCount()).toBe(1);
    expect(f.sessions[0]?.status).toBe("Revoked");
    expect(verifyPlatformAuditChain(f.records)).toBe(true);
  });
  it("replays the original receipt after later head without allocation or repeated revocation", async () => {
    const f = fixture(),
      p = f.make(),
      first = await p.provision(initial());
    await f.finish(p);
    const command = lifecycle(first, "Disable", 10),
      q = f.make(),
      disabled = await q.provision(command);
    await f.finish(q);
    const restore = f.make();
    await restore.provision(lifecycle(disabled, "Restore", 11));
    await f.finish(restore);
    const allocations = f.allocated(),
      audits = f.records.length,
      writes = f.calls.filter((c) =>
        c.sql.startsWith("UPDATE bop_identity.authentication_session"),
      ).length,
      replay = f.make();
    expect(await replay.provision(command)).toEqual(disabled);
    await f.finish(replay);
    expect(f.allocated()).toBe(allocations);
    expect(f.records).toHaveLength(audits);
    expect(
      f.calls.filter((c) => c.sql.startsWith("UPDATE bop_identity.authentication_session")),
    ).toHaveLength(writes);
  });
  it("refuses intent changes and stale CAS before fresh allocation", async () => {
    const f = fixture(),
      p = f.make(),
      r = await p.provision(initial());
    await f.finish(p);
    const n = f.allocated();
    await expect(
      f.make().provision({ ...initial(), subject: "another-subject" }),
    ).rejects.toMatchObject({ code: "PLATFORM_ACTOR_DIRECTORY_INTENT_CONFLICT" });
    await expect(
      f
        .make()
        .provision({
          ...lifecycle(r, "Suspend", 10),
          expectedHead: { revisionReference: id(99), version: 1, sourceDigest: r.sourceDigest },
        }),
    ).rejects.toMatchObject({ code: "PLATFORM_ACTOR_DIRECTORY_VERSION_CONFLICT" });
    expect(f.allocated()).toBe(n);
  });
  it("refuses lifecycle original replay across environment, issuer or client configuration", async () => {
    for (const config of [
      { ...configuration, environment: "other" },
      {
        ...configuration,
        issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Other",
      },
      { ...configuration, clientIds: ["otherclient"] },
    ]) {
      const f = fixture(),
        p = f.make(),
        r = await p.provision(initial());
      await f.finish(p);
      const command = lifecycle(r, "Suspend", 10),
        q = f.make();
      await q.provision(command);
      await f.finish(q);
      const n = f.allocated();
      await expect(
        f
          .make({ configuration: parsePlatformActorDirectoryConfiguration(config) })
          .provision(command),
      ).rejects.toThrow();
      expect(f.allocated()).toBe(n);
    }
  });
  it("requires real approval, controlled login and current Provider status before fresh IDs", async () => {
    for (const denied of ["approval", "role", "provider"]) {
      const f = fixture();
      if (denied === "approval") f.deny();
      else if (denied === "role") f.badRole();
      else f.disableProvider();
      await expect(f.make().provision(initial())).rejects.toThrow();
      expect(f.allocated()).toBe(30);
      expect(f.records).toHaveLength(0);
      expect(
        f.calls.some((c) =>
          c.sql.startsWith("INSERT INTO bop_identity.platform_actor_directory_revision"),
        ),
      ).toBe(false);
    }
  });
  it("reobserves approval and Provider before COMMIT and seals original lease synchronously", async () => {
    const f = fixture(),
      p = f.make();
    await p.provision(initial());
    f.deny();
    await expect(f.runGuard()).rejects.toThrow();
    expect(() => p.assertFinalized()).toThrow();
    const g = fixture(),
      q = g.make();
    await q.provision(initial());
    g.disableProvider();
    await expect(g.runGuard()).rejects.toThrow();
    const h = fixture(),
      r = h.make();
    await r.provision(initial());
    await h.runGuard();
    h.setTime(deadline);
    expect(() => h.runFinal()).toThrow();
    expect(() => r.assertFinalized()).toThrow();
  });
  it("requires caller rollback after actual Audit failure or query drift and refuses reentry", async () => {
    const f = fixture();
    f.failAudit();
    const p = f.make();
    await expect(p.provision(initial())).rejects.toThrow();
    expect(() => p.assertFinalized()).toThrow();
    const g = fixture(),
      q = g.make();
    await q.provision(initial());
    let foreignCalls = 0;
    g.tx.query = async () => {
      foreignCalls++;
      return { rows: [] };
    };
    await expect(g.runGuard()).rejects.toThrow();
    expect(foreignCalls).toBe(0);
    const h = fixture(),
      r = h.make(),
      first = r.provision(initial());
    await expect(r.provision(initial())).rejects.toThrow();
    await expect(first).rejects.toThrow();
  });
});
