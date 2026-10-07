import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { canonicalizeRfc8785 } from "@bop/audit";
import { parseRawBrowserCredential, parseSelectorHash } from "../contracts/browser-session.js";
import {
  buildPlatformActorDirectoryRevision,
  parsePlatformActorDirectoryCommand,
  parsePlatformActorDirectoryConfiguration,
  platformActorDirectoryIntent,
  platformActorDirectoryOriginal,
  platformActorSubjectContext,
} from "../contracts/platform-actor-directory.js";
import {
  platformActorDirectoryCodec,
  platformActorDirectorySubjectHash,
} from "../infrastructure/persistence/platform-actor-directory-store.js";
import { createBrandInitialProvisioningOperatorSource } from "../infrastructure/brand-initial-provisioning-operator.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
import type { OidcAuthorizationTransaction } from "../infrastructure/persistence/oidc-authorization-store.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  at = "2026-10-06T12:00:00.000Z",
  until = "2026-10-06T12:00:05.000Z",
  subject = "controlled-opaque-subject";
const sdk = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-cognito-identity-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-cognito-identity-provider")>();
  return {
    ...actual,
    CognitoIdentityProviderClient: class {
      send = sdk.send;
    },
  };
});
let enabled = true;
beforeEach(() => {
  enabled = true;
  sdk.send.mockReset();
  sdk.send.mockImplementation(async (command: unknown) => {
    expect(command).toBeInstanceOf(AdminGetUserCommand);
    return {
      Enabled: enabled,
      UserStatus: "CONFIRMED",
      UserAttributes: [{ Name: "sub", Value: subject }],
    };
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});
/** Actual Session/directory/Cognito factories, AES-GCM and HMAC. Only SQL rows
 * and the outbound SDK boundary are controlled; no deployed identity evidence. */
async function fixture() {
  const key = Buffer.alloc(32, 7);
  const hasher: BrowserCredentialHasherPort = {
    hash: (value) => parseSelectorHash(createHmac("sha256", key).update(value).digest("hex")),
    equals: (a, b) => a === b,
  };
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(text, context) {
      const iv = Buffer.alloc(12, 3),
        c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(context));
      const bytes = Buffer.concat([c.update(text), c.final()]);
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-key",
        ciphertext: Buffer.concat([iv, bytes, c.getAuthTag()]).toString("base64url"),
        encryptionContext: context,
      };
    },
    async decrypt(e, context) {
      const b = Buffer.from(e.ciphertext, "base64url"),
        d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAAD(Buffer.from(context));
      d.setAuthTag(b.subarray(-16));
      return Buffer.concat([d.update(b.subarray(12, -16)), d.final()]).toString();
    },
  };
  const configuration = {
      environment: "controlled",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
      clientId: "controlledclient",
      redirectUri: "https://platform.invalid/platform/callback",
      allowedPostLoginPaths: ["/platform/templates"],
    },
    directoryConfig = parsePlatformActorDirectoryConfiguration({
      environment: configuration.environment,
      issuer: configuration.issuer,
      clientIds: [configuration.clientId],
    });
  const command = parsePlatformActorDirectoryCommand({
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
    subjectHash = platformActorDirectorySubjectHash(hasher, directoryConfig, subject),
    originalCommand = platformActorDirectoryOriginal(command, subjectHash);
  let revision = buildPlatformActorDirectoryRevision(
    {
      profile: "PlatformActorDirectoryRevisionV1",
      actorReference: id(2),
      configuration: directoryConfig,
      subjectHash,
      encryptedSubject: await envelopes.encrypt(
        JSON.stringify({ subject }),
        platformActorSubjectContext(directoryConfig, id(2)),
      ),
      revisionReference: id(6),
      version: 1,
      supersedesRevisionReference: null,
      status: "Active",
      operationReference: command.operationReference,
      intentDigest: platformActorDirectoryIntent(originalCommand, platformActorDirectoryCodec),
      originalCommand,
      recordedByReference: command.recordedByReference,
      approvedByReference: command.approvedByReference,
      approvalReference: command.approvalReference,
      reasonCode: command.reasonCode,
      auditReference: id(7),
      recordedAt: at,
      classification: "RestrictedSecurity",
    },
    platformActorDirectoryCodec,
  );
  const cookie = parseRawBrowserCredential(Buffer.alloc(32, 8).toString("base64url")),
    csrf = parseRawBrowserCredential(Buffer.alloc(32, 9).toString("base64url")),
    context = `${configuration.environment}:platform-session:${id(10)}:${id(2)}`;
  const secrets = {
    profile: "PlatformBrowserSessionV1",
    issuer: configuration.issuer,
    clientId: configuration.clientId,
    tokenBundle: "controlled-secret-bundle",
    csrf,
    mfa: {
      sessionReference: id(10),
      actorReference: id(2),
      method: "Totp",
      evidenceReference: id(11),
      authorizationTransactionReference: id(12),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-10-06T12:15:00.000Z",
    },
  };
  const encrypted = await envelopes.encrypt(JSON.stringify(secrets), context);
  const row: Record<string, unknown> = {
    session_id: id(10),
    actor_id: id(2),
    policy_code: "Privileged",
    status: "Active",
    authenticated_at: new Date(at),
    created_at: new Date(at),
    last_seen_at: new Date(at),
    idle_expires_at: new Date("2026-10-06T12:15:00.000Z"),
    absolute_expires_at: new Date("2026-10-06T20:00:00.000Z"),
    rotated_from_session_id: null,
    revocation_reason: null,
    revoked_at: null,
    version: 1,
    cipher_algorithm: encrypted.algorithm,
    key_reference: encrypted.keyReference,
    encrypted_secret: Buffer.from(encrypted.ciphertext, "base64url"),
    encryption_context: context,
    session_selector_hash: Buffer.from(hasher.hash(cookie), "hex"),
    csrf_selector_hash: Buffer.from(hasher.hash(csrf), "hex"),
  };
  let time = at,
    missing = false;
  const calls: string[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const tx: OidcAuthorizationTransaction = {
    async query(sql) {
      calls.push(sql);
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
      if (sql.includes("authentication_session WHERE")) return { rows: [row] };
      return { rows: [] };
    },
  };
  const options = {
    transaction: tx,
    configuration,
    clock: { now: () => time },
    hasher,
    envelopes,
    originalObservedAt: at,
    originalValidUntil: until,
    cookie,
    actorReference: id(2),
    registerBeforeCommit: async (
      actual: OidcAuthorizationTransaction,
      guard: () => Promise<void>,
      final: () => void,
    ) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
  };
  const source = createBrandInitialProvisioningOperatorSource(options);
  return {
    source,
    options,
    row,
    calls,
    guards,
    finals,
    secrets,
    envelopes,
    context,
    setTime: (v: string) => {
      time = v;
    },
    missing: () => {
      missing = true;
    },
    withdraw: () => {
      revision = buildPlatformActorDirectoryRevision(
        { ...revision, status: "Disabled" },
        platformActorDirectoryCodec,
      );
    },
    async alterMfa() {
      const changed = await envelopes.encrypt(
        JSON.stringify({ ...secrets, mfa: { ...secrets.mfa, evidenceReference: id(99) } }),
        context,
      );
      row.encrypted_secret = Buffer.from(changed.ciphertext, "base64url");
    },
    async finalize() {
      for (const g of guards) await g();
      for (const f of finals) f();
      source.assertFinalized();
    },
  };
}
describe("actual initial provisioning Platform operator", () => {
  it("maps actual same Session Totp proof to RecentMfa and caches registrations", async () => {
    const f = await fixture();
    const a = await f.source.hold(),
      b = await f.source.hold();
    expect(a).toEqual(b);
    expect(a.actor).toMatchObject({
      actorReference: id(2),
      accountKind: "Platform",
      verificationLevel: "RecentMfa",
      recentMfaAt: at,
    });
    expect(a.validUntil).toBe(until);
    expect(f.guards).toHaveLength(2);
    await f.finalize();
    f.setTime("2026-10-06T12:30:00.000Z");
    expect(() => f.source.assertFinalized()).not.toThrow();
    await expect(f.source.hold()).rejects.toThrow();
  });
  it("permits repeated hold while host executes asynchronous checks without new guards", async () => {
    const f = await fixture();
    await f.source.hold();
    await f.guards[0]?.();
    await f.source.hold();
    await f.guards[1]?.();
    expect(f.guards).toHaveLength(2);
    for (const final of f.finals) final();
    f.source.assertFinalized();
  });
  it.each(["remote", "directory", "session", "mfa"])(
    "refuses late %s withdrawal/change",
    async (kind) => {
      const f = await fixture();
      await f.source.hold();
      if (kind === "remote") enabled = false;
      if (kind === "directory") f.missing();
      if (kind === "session") {
        f.row.status = "Revoked";
        f.row.revocation_reason = "Administrative";
        f.row.revoked_at = new Date(at);
      }
      if (kind === "mfa") await f.alterMfa();
      await expect(f.guards[0]?.()).rejects.toThrow();
      expect(() => f.finals[0]?.()).toThrow();
    },
  );
  it("keeps original deadline through later held reads", async () => {
    const f = await fixture();
    await f.source.hold();
    f.setTime("2026-10-06T12:00:04.000Z");
    expect((await f.source.hold()).validUntil).toBe(until);
    f.setTime(until);
    await expect(f.source.hold()).rejects.toThrow();
  });
  it("registers owning poison guard before malformed first Session read", async () => {
    const f = await fixture();
    f.row.actor_id = id(99);
    await expect(f.source.hold()).rejects.toThrow();
    expect(f.guards.length).toBeGreaterThan(0);
    await expect(f.guards[0]?.()).rejects.toThrow();
  });
  it("poisons drift and backwards or malformed clocks", async () => {
    for (const mode of ["port", "backwards", "invalid"]) {
      const f = await fixture();
      await f.source.hold();
      if (mode === "port") f.options.hasher.hash = () => parseSelectorHash("f".repeat(64));
      if (mode === "backwards") f.setTime("2026-10-06T11:59:59.000Z");
      if (mode === "invalid") f.setTime("bad");
      await expect(f.source.hold()).rejects.toThrow();
      f.setTime(at);
      await expect(f.guards[0]?.()).rejects.toThrow();
    }
  });
  it("refuses parallel hold and poisons previously registered holder", async () => {
    const f = await fixture();
    const first = f.source.hold();
    await expect(f.source.hold()).rejects.toThrow();
    await expect(first).rejects.toThrow();
    await expect(f.guards[0]?.()).rejects.toThrow();
  });
  it("requires async guard before final and rejects final reuse", async () => {
    const f = await fixture();
    await f.source.hold();
    expect(() => f.finals[0]?.()).toThrow();
    await expect(f.guards[0]?.()).rejects.toThrow();
    const good = await fixture();
    await good.source.hold();
    await good.finalize();
    expect(() => good.finals[0]?.()).toThrow();
  });
  it("rejects unbounded lease/foreign expected actor or cookie", async () => {
    const f = await fixture();
    expect(() =>
      createBrandInitialProvisioningOperatorSource({
        ...f.options,
        originalValidUntil: "2026-10-06T12:00:05.001Z",
      }),
    ).toThrow();
    const wrong = createBrandInitialProvisioningOperatorSource({
      ...f.options,
      actorReference: id(99),
    });
    await expect(wrong.hold()).rejects.toThrow();
    expect(() =>
      createBrandInitialProvisioningOperatorSource({ ...f.options, cookie: "private-canary" }),
    ).toThrow();
  });
});
