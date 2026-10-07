import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalizeRfc8785 } from "@bop/audit";
import { parseSelectorHash } from "../contracts/browser-session.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import {
  buildPlatformActorDirectoryRevision,
  parsePlatformActorDirectoryCommand,
  parsePlatformActorDirectoryConfiguration,
  platformActorDirectoryIntent,
  platformActorDirectoryOriginal,
  platformActorSubjectContext,
  type PlatformActorDirectoryRevision,
} from "../contracts/platform-actor-directory.js";
import {
  createPostgresPlatformActorDirectorySource,
  platformActorDirectoryCodec,
  platformActorDirectorySubjectHash,
  type PlatformActorDirectorySourceOptions,
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
function cryptoPorts() {
  const key = Buffer.alloc(32, 7),
    hasher: BrowserCredentialHasherPort = {
      hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
      equals: (a, b) => a === b,
    },
    envelopes: SessionEnvelopeCryptoPort = {
      async encrypt(text, context) {
        const iv = Buffer.alloc(12, 3),
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
        return Buffer.concat([
          decipher.update(bytes.subarray(12, -16)),
          decipher.final(),
        ]).toString();
      },
    };
  return { hasher, envelopes };
}
async function fixture() {
  const ports = cryptoPorts();
  let time = at,
    remoteEnabled = true,
    missing = false;
  const c = parsePlatformActorDirectoryCommand({
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
    }),
    subjectHash = platformActorDirectorySubjectHash(ports.hasher, configuration, subject),
    originalCommand = platformActorDirectoryOriginal(c, subjectHash);
  let revision: PlatformActorDirectoryRevision = buildPlatformActorDirectoryRevision(
    {
      profile: "PlatformActorDirectoryRevisionV1",
      actorReference: id(2),
      configuration,
      subjectHash,
      encryptedSubject: await ports.envelopes.encrypt(
        JSON.stringify({ subject }),
        platformActorSubjectContext(configuration, id(2)),
      ),
      revisionReference: id(6),
      version: 1,
      supersedesRevisionReference: null,
      status: "Active",
      operationReference: c.operationReference,
      intentDigest: platformActorDirectoryIntent(originalCommand, platformActorDirectoryCodec),
      originalCommand,
      recordedByReference: c.recordedByReference,
      approvedByReference: c.approvedByReference,
      approvalReference: c.approvalReference,
      reasonCode: c.reasonCode,
      auditReference: id(7),
      recordedAt: at,
      classification: "RestrictedSecurity",
    },
    platformActorDirectoryCodec,
  );
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const tx: PlatformActorDirectoryTransaction = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes("AS isolation")) return { rows: [{ isolation: "read committed" }] };
      if (sql.includes("platform_actor_directory_read"))
        return {
          rows: missing
            ? []
            : [
                {
                  snapshot_text: canonicalizeRfc8785(revision),
                  source_digest: revision.sourceDigest,
                  coherent: true,
                },
              ],
        };
      return { rows: [] };
    },
  };
  let guard: (() => Promise<void>) | undefined,
    final: (() => void) | undefined,
    providerCalls = 0;
  const options: PlatformActorDirectorySourceOptions = {
    transaction: tx,
    configuration,
    clock: { now: () => time },
    originalObservedAt: at,
    originalValidUntil: deadline,
    ...ports,
    readCurrentProviderSubject: async (input) => {
      providerCalls++;
      return {
        issuer: input.issuer,
        subject: input.subject,
        status: remoteEnabled ? "Enabled" : "Disabled",
        observedAt: input.observedAt,
        validUntil: deadline,
      };
    },
    registerBeforeCommit: async (actual, g, f) => {
      expect(actual).toBe(tx);
      guard = g;
      final = f;
    },
  };
  const source = createPostgresPlatformActorDirectorySource(options);
  return {
    source,
    tx,
    calls,
    options,
    revision,
    ports,
    setTime: (v: string) => {
      time = v;
    },
    disable: () => {
      remoteEnabled = false;
    },
    missing: () => {
      missing = true;
    },
    badEnvelope: () => {
      const { sourceDigest, ...prior } = revision;
      expect(sourceDigest).toBe(revision.sourceDigest);
      revision = buildPlatformActorDirectoryRevision(
        {
          ...prior,
          encryptedSubject: { ...revision.encryptedSubject, ciphertext: "Y".repeat(64) },
        },
        platformActorDirectoryCodec,
      );
    },
    providerCalls: () => providerCalls,
    runGuard: async () => {
      if (!guard) throw new Error("missing guard");
      await guard();
    },
    runFinal: () => {
      if (!final) throw new Error("missing final");
      final();
    },
    finish: async () => {
      if (!guard || !final) throw new Error("missing guards");
      await guard();
      final();
      source.assertFinalized();
    },
  };
}
describe("actual transaction Platform directory source", () => {
  it("resolves an existing HMAC binding and actual provider status as SingleFactor", async () => {
    const f = await fixture();
    const result = await f.source.resolveVerifiedSubject({
      issuer: configuration.issuer,
      clientId: "controlledclient",
      subject,
      authenticatedAt: at,
      observedAt: at,
    });
    expect(result.actorReference).toBe(id(2));
    expect(result.verificationLevel).toBe("SingleFactor");
    expect(result.recentMfaAt).toBeNull();
    expect(f.calls.find((c) => c.sql.includes("platform_actor_directory_read"))?.values[1]).toBe(
      f.revision.subjectHash,
    );
    expect(JSON.stringify(f.calls)).not.toContain(subject);
    await f.finish();
    expect(f.providerCalls()).toBe(2);
  });
  it("binds currentActor to actual caller tx and reobserves remote withdrawal before COMMIT", async () => {
    const f = await fixture();
    expect((await f.source.currentActor(f.tx, id(2), at, at)).accountKind).toBe("Platform");
    f.disable();
    await expect(f.runGuard()).rejects.toThrow();
    expect(() => f.source.assertFinalized()).toThrow();
    const g = await fixture();
    await expect(
      g.source.currentActor({ query: async () => ({ rows: [] }) }, id(2), at, at),
    ).rejects.toThrow();
    expect(g.calls).toHaveLength(0);
  });
  it("rejects missing binding, wrong client and tampered ciphertext without inventing Actor", async () => {
    const f = await fixture();
    f.missing();
    await expect(f.source.currentActor(f.tx, id(2), at, at)).rejects.toThrow();
    const g = await fixture();
    await expect(
      g.source.resolveVerifiedSubject({
        issuer: configuration.issuer,
        clientId: "otherclient",
        subject,
        authenticatedAt: at,
        observedAt: at,
      }),
    ).rejects.toThrow();
    expect(g.calls).toHaveLength(0);
    const h = await fixture();
    h.badEnvelope();
    await expect(h.source.currentActor(h.tx, id(2), at, at)).rejects.toThrow();
  });
  it("seals original finite lease before COMMIT and never reads clock after finalized", async () => {
    const f = await fixture();
    await f.source.currentActor(f.tx, id(2), at, at);
    await f.runGuard();
    f.setTime(deadline);
    expect(() => f.runFinal()).toThrow();
    const g = await fixture();
    await g.source.currentActor(g.tx, id(2), at, at);
    await g.finish();
    const count = g.calls.length;
    g.setTime("2026-10-06T13:00:00.000Z");
    g.source.assertFinalized();
    expect(g.calls).toHaveLength(count);
  });
  it("poisons an existing hold when a caught public preflight is rejected", async () => {
    for (const kind of ["foreign", "actor", "client", "issuer", "extra"]) {
      const f = await fixture();
      await f.source.currentActor(f.tx, id(2), at, at);
      const request = {
        issuer: configuration.issuer,
        clientId: "controlledclient",
        subject,
        authenticatedAt: at,
        observedAt: at,
      };
      if (kind === "foreign")
        await expect(
          f.source.currentActor({ query: async () => ({ rows: [] }) }, id(2), at, at),
        ).rejects.toThrow();
      else if (kind === "actor")
        await expect(f.source.currentActor(f.tx, "bad", at, at)).rejects.toThrow();
      else {
        if (kind === "extra") Reflect.set(request, "extra", true);
        await expect(
          f.source.resolveVerifiedSubject(
            kind === "extra"
              ? request
              : kind === "issuer"
                ? { ...request, issuer: "wrong" }
                : { ...request, clientId: "wrong" },
          ),
        ).rejects.toThrow();
      }
      await expect(f.runGuard()).rejects.toThrow();
      expect(() => f.runFinal()).toThrow();
      expect(() => f.source.assertFinalized()).toThrow();
    }
  });
  it("rejects query/crypto drift and poisons concurrent reentry", async () => {
    const f = await fixture();
    f.tx.query = async () => ({ rows: [] });
    await expect(f.source.currentActor(f.tx, id(2), at, at)).rejects.toThrow();
    const g = await fixture();
    const first = g.source.currentActor(g.tx, id(2), at, at);
    await expect(g.source.currentActor(g.tx, id(2), at, at)).rejects.toThrow();
    await expect(first).rejects.toThrow();
    const h = await fixture();
    h.ports.envelopes.decrypt = async () => JSON.stringify({ subject });
    await expect(h.source.currentActor(h.tx, id(2), at, at)).rejects.toThrow();
  });
});
