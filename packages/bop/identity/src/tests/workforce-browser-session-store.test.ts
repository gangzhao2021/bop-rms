import { Buffer } from "node:buffer";
import { expect, it } from "vitest";
import { createIdentityActor, parseCanonicalInstant } from "../contracts/identity-actor.js";
import { parseSessionReference, parseSessionVersion } from "../contracts/authentication-session.js";
import { parseSelectorHash } from "../contracts/browser-session.js";
import { createPostgresWorkforceBrowserSessionStore } from "../infrastructure/persistence/browser-session-store.js";
import type { OidcAuthorizationTransaction } from "../infrastructure/persistence/oidc-authorization-store.js";
import type { SessionEnvelopeCryptoPort } from "../application/ports/session-credential-ports.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z";
// Controlled SQL/crypto boundaries; actual PostgreSQL and cipher acceptance is separate native evidence.
function fixture(alterInserted?: (row: Record<string, unknown>) => void) {
  let clock = at,
    active = true,
    failInsert = false;
  const records = new Map<string, Record<string, unknown>>(),
    plaintext = new Map<string, string>(),
    sql: string[] = [];
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(value, context) {
      plaintext.set(context, value);
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "synthetic",
        ciphertext: Buffer.alloc(32).toString("base64url"),
        encryptionContext: context,
      };
    },
    async decrypt(value, context) {
      if (value.encryptionContext !== context) throw new Error("synthetic AAD");
      const text = plaintext.get(context);
      if (!text) throw new Error("synthetic missing");
      return text;
    },
  };
  const actor = (authenticatedAt: string) =>
    createIdentityActor({
      actorType: "User",
      actorReference: id(1),
      accountKind: "Workforce",
      status: active ? "Active" : "Disabled",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt,
      recentMfaAt: null,
    });
  const tx: OidcAuthorizationTransaction = {
    async query(text, values) {
      sql.push(text);
      if (text.startsWith("LOCK TABLE")) return { rows: [] };
      if (text.startsWith("SELECT *")) {
        const r = records.get(String(values[0]));
        return { rows: r ? [r] : [] };
      }
      if (text.startsWith("SELECT session_id,created_at"))
        return {
          rows: [...records.values()]
            .filter((r) => r.status === "Active")
            .map((r) => ({ ...r, exact_created_at: true })),
        };
      if (text.startsWith("INSERT INTO bop_identity.authentication_session")) {
        if (failInsert) throw new Error("synthetic insert failure");
        records.set(String(values[2]), {
          session_id: values[0],
          actor_id: values[1],
          session_selector_hash: Buffer.from(String(values[2]), "hex"),
          csrf_selector_hash: Buffer.from(String(values[3]), "hex"),
          policy_code: values[4],
          status: "Active",
          encrypted_secret: values[5],
          cipher_algorithm: values[6],
          key_reference: values[7],
          encryption_context: values[8],
          authenticated_at: new Date(String(values[9])),
          created_at: new Date(String(values[10])),
          last_seen_at: new Date(String(values[11])),
          idle_expires_at: new Date(String(values[12])),
          absolute_expires_at: new Date(String(values[13])),
          rotated_from_session_id: values[14],
          version: values[15],
          revocation_reason: null,
          revoked_at: null,
        });
        const saved = records.get(String(values[2]));
        if (!saved) throw Error("missing controlled inserted Session");
        alterInserted?.(saved);
        return { rows: [] };
      }
      if (text.startsWith("UPDATE bop_identity.authentication_session SET status='Revoked'")) {
        for (const row of records.values())
          if (row.session_id === values[0]) {
            row.status = "Revoked";
            row.revocation_reason = "RiskChange";
            row.revoked_at = new Date(String(values[1]));
            row.version = Number(row.version) + 1;
          }
        return { rows: [] };
      }
      throw new Error("Unexpected controlled SQL");
    },
  };
  const options = {
    environment: "synthetic",
    issuer: "https://identity.invalid/",
    clientId: "workforce",
    redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
    allowedPostLoginPaths: ["/app/organization/brands"],
    now: () => clock,
    envelopes,
    hasher: {
      hash: (value: string) => parseSelectorHash((value === "y".repeat(43) ? "d" : "c").repeat(64)),
      equals: (a: string, b: string) => a === b,
    },
    currentActor: async (_tx: OidcAuthorizationTransaction, _ref: string, auth: string) =>
      actor(auth),
    transactions: {
      async run<T>(work: (actual: OidcAuthorizationTransaction) => Promise<T>) {
        const prior = new Map([...records].map(([k, v]) => [k, { ...v }]));
        try {
          return await work(tx);
        } catch (error) {
          records.clear();
          for (const [k, v] of prior) records.set(k, v);
          throw error;
        }
      },
    },
  };
  const store = createPostgresWorkforceBrowserSessionStore(options);
  async function command(n = 2, auth = at) {
    const sessionReference = parseSessionReference(id(n)),
      context = `synthetic:session:${sessionReference}:${id(1)}`;
    const encryptedSecrets = await envelopes.encrypt(
      JSON.stringify({
        profile: "WorkforceBrowserSessionV1",
        issuer: options.issuer,
        clientId: options.clientId,
        tokenBundle: "synthetic-token",
        csrf: (n === 3 ? "y" : "x").repeat(43),
        mfa: {
          sessionReference,
          actorReference: id(1),
          method: "Totp",
          evidenceReference: id(n + 100),
          authorizationTransactionReference: id(n + 200),
          authenticatedAt: auth,
          verifiedAt: auth,
          validUntil: new Date(Date.parse(auth) + 900000).toISOString(),
        },
      }),
      context,
    );
    return {
      sessionReference,
      actor: actor(auth),
      policyCode: "Privileged" as const,
      sessionSelectorHash: parseSelectorHash(String(n).repeat(64).slice(0, 64)),
      csrfSelectorHash: parseSelectorHash((n === 3 ? "d" : "c").repeat(64)),
      encryptedSecrets,
      observedAt: parseCanonicalInstant(clock),
    };
  }
  return {
    store,
    options,
    command,
    records,
    sql,
    plaintext,
    clock: (v: string) => {
      clock = v;
    },
    withdraw: () => {
      active = false;
    },
    fail: () => {
      failInsert = true;
    },
  };
}
it("stores genuine Workforce kind with proof-required fixed Privileged policy and merchant AAD", async () => {
  const f = fixture(),
    c = await f.command(),
    record = await f.store.createSession(c);
  expect(record.session.actor.accountKind).toBe("Workforce");
  expect(record.session.actor.verificationLevel).toBe("SingleFactor");
  expect("rotateSession" in f.store).toBe(false);
  expect((await f.store.resolveSession(c.sessionSelectorHash))?.session.sessionReference).toBe(
    c.sessionReference,
  );
  expect(f.sql.some((s) => s.includes("authenticated_at=date_trunc"))).toBe(true);
});
it.each(["profile", "session", "csrf", "policy"])(
  "rejects mismatched %s rather than legacy fallback",
  async (mode) => {
    const f = fixture(),
      c = await f.command();
    if (mode === "policy")
      await expect(
        f.store.createSession({ ...c, policyCode: "WorkforceStandard" }),
      ).rejects.toThrow();
    else {
      const text = JSON.parse(f.plaintext.get(c.encryptedSecrets.encryptionContext) ?? "null");
      if (mode === "profile") text.profile = "PlatformBrowserSessionV1";
      if (mode === "session") text.mfa.sessionReference = id(9);
      if (mode === "csrf") text.csrf = "y".repeat(43);
      f.plaintext.set(c.encryptedSecrets.encryptionContext, JSON.stringify(text));
      await expect(f.store.createSession(c)).rejects.toThrow();
    }
    expect(f.records.size).toBe(0);
  },
);
it("replaces only same Actor with fresh proof and rolls back old revocation on insert failure", async () => {
  const f = fixture(),
    first = await f.command();
  await f.store.createSession(first);
  f.clock("2026-09-10T10:01:00.000Z");
  const next = await f.command(3, "2026-09-10T10:01:00.000Z");
  f.fail();
  await expect(
    f.store.replaceAfterStepUp({
      currentSelectorHash: first.sessionSelectorHash,
      expectedSessionReference: first.sessionReference,
      expectedVersion: parseSessionVersion(1),
      nextSessionReference: next.sessionReference,
      actor: next.actor,
      nextSelectorHash: next.sessionSelectorHash,
      nextCsrfSelectorHash: parseSelectorHash("d".repeat(64)),
      nextEncryptedSecrets: next.encryptedSecrets,
      observedAt: next.observedAt,
    }),
  ).rejects.toThrow();
  expect(f.records.get(first.sessionSelectorHash)?.status).toBe("Active");
});
it("refuses withdrawn current Workforce identity before persistence", async () => {
  const f = fixture(),
    c = await f.command();
  f.withdraw();
  await expect(f.store.createSession(c)).rejects.toThrow();
  expect(f.records.size).toBe(0);
});
it("atomically replaces a Workforce Session with fresh selector, CSRF and TOTP lineage", async () => {
  const f = fixture(),
    first = await f.command();
  await f.store.createSession(first);
  f.clock("2026-09-10T10:01:00.000Z");
  const next = await f.command(3, "2026-09-10T10:01:00.000Z"),
    record = await f.store.replaceAfterStepUp({
      currentSelectorHash: first.sessionSelectorHash,
      expectedSessionReference: first.sessionReference,
      expectedVersion: parseSessionVersion(1),
      nextSessionReference: next.sessionReference,
      actor: next.actor,
      nextSelectorHash: next.sessionSelectorHash,
      nextCsrfSelectorHash: next.csrfSelectorHash,
      nextEncryptedSecrets: next.encryptedSecrets,
      observedAt: next.observedAt,
    });
  expect(record.session.actor.accountKind).toBe("Workforce");
  expect(record.session.rotatedFromSessionReference).toBe(first.sessionReference);
  expect(record.session.version).toBe(2);
  expect(f.records.get(first.sessionSelectorHash)?.status).toBe("Revoked");
  expect((await f.store.resolveSession(next.sessionSelectorHash))?.session.sessionReference).toBe(
    next.sessionReference,
  );
});
it("rejects captured port drift and proof reuse", async () => {
  const f = fixture(),
    c = await f.command();
  const decrypt = f.options.envelopes.decrypt;
  f.options.envelopes.decrypt = async (...args) => {
    f.options.envelopes.decrypt = decrypt;
    return decrypt(...args);
  };
  await expect(f.store.createSession(c)).rejects.toThrow();
  expect(f.records.size).toBe(0);
  const g = fixture(),
    first = await g.command();
  await g.store.createSession(first);
  g.clock("2026-09-10T10:01:00.000Z");
  const next = await g.command(3, "2026-09-10T10:01:00.000Z"),
    text = JSON.parse(g.plaintext.get(next.encryptedSecrets.encryptionContext) ?? "null");
  text.mfa.evidenceReference = id(102);
  g.plaintext.set(next.encryptedSecrets.encryptionContext, JSON.stringify(text));
  await expect(
    g.store.replaceAfterStepUp({
      currentSelectorHash: first.sessionSelectorHash,
      expectedSessionReference: first.sessionReference,
      expectedVersion: parseSessionVersion(1),
      nextSessionReference: next.sessionReference,
      actor: next.actor,
      nextSelectorHash: next.sessionSelectorHash,
      nextCsrfSelectorHash: next.csrfSelectorHash,
      nextEncryptedSecrets: next.encryptedSecrets,
      observedAt: next.observedAt,
    }),
  ).rejects.toThrow();
  expect(g.records.get(first.sessionSelectorHash)?.status).toBe("Active");
});

it("accepts identical envelope values in a different field order through the actual final DB reread", async () => {
  const f = fixture(),
    command = await f.command(),
    e = command.encryptedSecrets;
  const encryptedSecrets = {
    algorithm: e.algorithm,
    keyReference: e.keyReference,
    encryptionContext: e.encryptionContext,
    ciphertext: e.ciphertext,
  };
  expect(Object.keys(encryptedSecrets)).not.toEqual(Object.keys(e));
  const record = await f.store.createSession({ ...command, encryptedSecrets });
  expect(record.encryptedSecrets).toEqual(e);
  const current = await f.store.resolveSession(command.sessionSelectorHash);
  expect(current?.encryptedSecrets).toEqual(e);
  expect(f.sql.filter((sql) => sql.startsWith("SELECT *")).length).toBeGreaterThanOrEqual(2);
});
it.each(["key_reference", "encrypted_secret", "version"] as const)(
  "still rejects a real persisted %s change at the same final reread",
  async (field) => {
    const f = fixture((row) => {
        row[field] =
          field === "key_reference"
            ? "other-controlled-key"
            : field === "version"
              ? 2
              : Buffer.alloc(32, 1);
      }),
      command = await f.command();
    await expect(f.store.createSession(command)).rejects.toThrow();
    expect(f.records.size).toBe(0);
    expect(f.sql.some((sql) => sql.startsWith("INSERT INTO"))).toBe(true);
    expect(f.sql.some((sql) => sql.startsWith("SELECT *"))).toBe(true);
  },
);
