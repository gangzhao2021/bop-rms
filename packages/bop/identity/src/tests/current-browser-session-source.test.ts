import { Buffer } from "node:buffer";
import { createAuthenticationSession } from "../contracts/authentication-session.js";
import { createBrowserSessionRecord } from "../contracts/browser-session.js";
import {
  createPostgresCurrentWorkforceBrowserSessionRecordSource,
  createPostgresCurrentWorkforceBrowserSessionSource,
} from "../infrastructure/persistence/current-browser-session-source.js";
import { expect, it, vi } from "vitest";
import {
  createIdentityActor,
  createPostgresCurrentBrowserSessionSource,
  parseSelectorHash,
} from "../index.js";
const id = (n: number) => "0190ed60-0000-7000-8000-" + String(n).padStart(12, "0");
const at = "2026-09-10T10:00:00.000Z";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: id(1),
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: at,
  recentMfaAt: null,
});
function fixture() {
  const row: Record<string, unknown> = {
    session_id: id(2),
    actor_id: id(1),
    policy_code: "WorkforceStandard",
    status: "Active",
    authenticated_at: new Date(at),
    created_at: new Date(at),
    last_seen_at: new Date(at),
    idle_expires_at: new Date("2026-09-10T10:30:00.000Z"),
    absolute_expires_at: new Date("2026-09-10T22:00:00.000Z"),
    rotated_from_session_id: null,
    revocation_reason: null,
    revoked_at: null,
    version: 1,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let current = actor;
  let disabled = false;
  let records = [row];
  const read = createPostgresCurrentBrowserSessionSource({
    now: () => "2026-09-10T10:10:00.000Z",
    hasher: { hash: () => parseSelectorHash("a".repeat(64)), equals: (a, b) => a === b },
    currentActor: async () => {
      if (disabled) throw new Error("synthetic inactive actor");
      return current;
    },
  });
  const tx = {
    async query(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      return { rows: records };
    },
  };
  return {
    row,
    calls,
    disableActor: () => {
      disabled = true;
    },
    read: (cookie: unknown = "x".repeat(43)) => read(tx, cookie),
    setActor: (value: typeof actor) => {
      current = value;
    },
    setRows: (value: typeof records) => {
      records = value;
    },
  };
}
it("resolves only session fields through hashed credential and a row fence", async () => {
  const f = fixture();
  expect((await f.read()).sessionReference).toBe(id(2));
  expect(f.calls[0]?.values).toEqual(["a".repeat(64)]);
  expect(f.calls[0]?.sql).toContain("FOR SHARE");
  expect(f.calls[0]?.sql).not.toMatch(/encrypted_secret|csrf_selector_hash|SELECT [*]/u);
});
it("rejects malformed credentials before SQL", async () => {
  const f = fixture();
  await expect(f.read("private-canary")).rejects.toThrow("request denied");
  expect(f.calls).toHaveLength(0);
});
it.each(["missing", "duplicate"])("rejects %s session records", async (kind) => {
  const f = fixture();
  f.setRows(kind === "missing" ? [] : [f.row, f.row]);
  await expect(f.read()).rejects.toThrow();
});
it.each(["Revoked", "Expired"])("rejects %s sessions", async (status) => {
  const f = fixture();
  f.row.status = status;
  if (status === "Revoked") {
    f.row.revocation_reason = "Logout";
    f.row.revoked_at = new Date(at);
  }
  await expect(f.read()).rejects.toThrow();
});
it("rejects actor binding mismatch", async () => {
  const f = fixture();
  f.setActor(createIdentityActor({ ...actor, actorReference: id(3) }));
  await expect(f.read()).rejects.toThrow();
});
it("rejects disabled identity despite an active session", async () => {
  const f = fixture();
  f.disableActor();
  await expect(f.read()).rejects.toThrow();
});
it("rejects future interactive activity", async () => {
  const f = fixture();
  f.row.last_seen_at = new Date("2026-09-10T10:20:00.000Z");
  f.row.idle_expires_at = new Date("2026-09-10T10:50:00.000Z");
  await expect(f.read()).rejects.toThrow();
});

// Strong Workforce reader unit boundary: remote account and cipher ports are controlled.
function strongFixture() {
  let now = "2026-09-10T10:10:00.000Z",
    current = actor;
  const row: Record<string, unknown> = {
    session_id: id(2),
    actor_id: id(1),
    policy_code: "Privileged",
    status: "Active",
    authenticated_at: new Date(at),
    created_at: new Date(at),
    last_seen_at: new Date(at),
    idle_expires_at: new Date("2026-09-10T10:15:00.000Z"),
    absolute_expires_at: new Date("2026-09-10T18:00:00.000Z"),
    rotated_from_session_id: null,
    revocation_reason: null,
    revoked_at: null,
    version: 1,
    cipher_algorithm: "SYNTHETIC_AES_256_GCM",
    key_reference: "synthetic",
    encrypted_secret: new Uint8Array(32),
    encryption_context: `synthetic:session:${id(2)}:${id(1)}`,
    csrf_selector_hash: new Uint8Array(32).fill(170),
  };
  const proof = {
    profile: "WorkforceBrowserSessionV1",
    issuer: "https://identity.invalid/",
    clientId: "workforce",
    tokenBundle: "private-unit-canary",
    csrf: "x".repeat(43),
    mfa: {
      sessionReference: id(2),
      actorReference: id(1),
      method: "Totp",
      evidenceReference: id(4),
      authorizationTransactionReference: id(5),
      authenticatedAt: at,
      verifiedAt: at,
      validUntil: "2026-09-10T10:15:00.000Z",
    },
  };
  let afterQuery: (() => void) | undefined, afterDecrypt: (() => void) | undefined;
  const sql: string[] = [];
  const tx = {
    async query(text: string, _values: readonly unknown[]) {
      sql.push(text);
      afterQuery?.();
      return { rows: _values[0] === "a".repeat(64) ? [row] : [] };
    },
  };
  const options = {
    configuration: { environment: "synthetic", issuer: proof.issuer, clientId: proof.clientId },
    now: () => now,
    hasher: {
      hash: () => parseSelectorHash("a".repeat(64)),
      equals: (a: string, b: string) => a === b,
    },
    currentActor: async () => current,
    envelopes: {
      async encrypt() {
        throw new Error("unused");
      },
      async decrypt() {
        afterDecrypt?.();
        return JSON.stringify(proof);
      },
    },
  };
  const read = createPostgresCurrentWorkforceBrowserSessionSource(options);
  return {
    row,
    proof,
    options,
    tx,
    sql,
    read: () => read(tx, "x".repeat(43)),
    clock: (value: string) => {
      now = value;
    },
    actor: (value: typeof actor) => {
      current = value;
    },
    afterQuery: (work: () => void) => {
      afterQuery = work;
    },
    afterDecrypt: (work: () => void) => {
      afterDecrypt = work;
    },
  };
}
it("derives Workforce RecentMfa only from exact encrypted same-session proof and emits no security payload", async () => {
  const f = strongFixture(),
    result = await f.read();
  expect(result.actor.verificationLevel).toBe("RecentMfa");
  expect(result.actor.recentMfaAt).toBe(at);
  expect(JSON.stringify(result)).not.toMatch(
    /private-unit-canary|csrf|tokenBundle|evidenceReference/,
  );
  expect(f.sql[0]).toContain("FOR SHARE");
  expect(f.sql[0]).toContain("authenticated_at=date_trunc");
});
it.each(["legacy", "session", "actor", "csrf", "issuer", "aad"])(
  "rejects strong Workforce %s mismatch",
  async (mode) => {
    const f = strongFixture();
    if (mode === "legacy") f.proof.profile = "PlatformBrowserSessionV1";
    if (mode === "session") f.proof.mfa.sessionReference = id(9);
    if (mode === "actor") f.proof.mfa.actorReference = id(9);
    if (mode === "csrf") f.row.csrf_selector_hash = new Uint8Array(32).fill(187);
    if (mode === "issuer") f.proof.issuer = "https://foreign.invalid";
    if (mode === "aad") f.row.encryption_context = "foreign";
    await expect(f.read()).rejects.toThrow();
  },
);
it("rejects account-level MFA metadata and stored authentication-time mismatch", async () => {
  const f = strongFixture();
  f.actor(createIdentityActor({ ...actor, verificationLevel: "RecentMfa", recentMfaAt: at }));
  await expect(f.read()).rejects.toThrow();
  f.actor(createIdentityActor({ ...actor, authenticatedAt: "2026-09-10T09:59:59.000Z" }));
  await expect(f.read()).rejects.toThrow();
});
it("refuses exact original five-second bound, backward clock, and post-await port drift", async () => {
  const f = strongFixture();
  f.afterQuery(() => f.clock("2026-09-10T10:10:05.000Z"));
  await expect(f.read()).rejects.toThrow();
  const g = strongFixture();
  g.afterDecrypt(() => g.clock("2026-09-10T10:09:59.999Z"));
  await expect(g.read()).rejects.toThrow();
  const h = strongFixture();
  h.afterDecrypt(() => {
    h.options.envelopes.decrypt = async () => JSON.stringify(h.proof);
  });
  await expect(h.read()).rejects.toThrow();
});
it("refuses proof expiry reached during decryption without renewing MFA", async () => {
  const f = strongFixture();
  f.clock("2026-09-10T10:14:59.999Z");
  f.row.last_seen_at = new Date("2026-09-10T10:14:59.000Z");
  f.row.idle_expires_at = new Date("2026-09-10T10:29:59.000Z");
  f.afterDecrypt(() => f.clock("2026-09-10T10:15:00.000Z"));
  await expect(f.read()).rejects.toThrow();
});

function insertedRecord(f: ReturnType<typeof strongFixture>) {
  const r = f.row;
  const session = createAuthenticationSession({
    sessionReference: r.session_id,
    actor,
    status: r.status,
    policyCode: "Privileged",
    maxActiveSessions: 2,
    idleTimeoutMinutes: 15,
    absoluteTimeoutMinutes: 480,
    version: r.version,
    authenticatedAt: at,
    createdAt: at,
    lastSeenAt: at,
    idleExpiresAt: "2026-09-10T10:15:00.000Z",
    absoluteExpiresAt: "2026-09-10T18:00:00.000Z",
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
  return createBrowserSessionRecord({
    session,
    sessionSelectorHash: parseSelectorHash("a".repeat(64)),
    csrfSelectorHash: parseSelectorHash("a".repeat(64)),
    encryptedSecrets: {
      algorithm: "SYNTHETIC_AES_256_GCM",
      keyReference: "synthetic",
      ciphertext: Buffer.from(new Uint8Array(32)).toString("base64url"),
      encryptionContext: `synthetic:session:${id(2)}:${id(1)}`,
    },
  });
}
it("re-observes the actual newly inserted record with strong DB proof without hashing a fabricated cookie", async () => {
  const f = strongFixture(),
    record = insertedRecord(f),
    values: unknown[] = [];
  const hash = f.options.hasher.hash;
  f.options.hasher.hash = () => {
    values.push("actual CSRF");
    return hash();
  };
  const read = createPostgresCurrentWorkforceBrowserSessionRecordSource(f.options);
  const result = await read(f.tx, record);
  expect(result.sessionReference).toBe(record.session.sessionReference);
  expect(result.version).toBe(record.session.version);
  expect(result.actor.verificationLevel).toBe("RecentMfa");
  expect(values).toEqual(["actual CSRF"]);
  expect(f.sql).toHaveLength(1);
  expect(f.sql[0]).toContain("FOR SHARE");
  expect(JSON.stringify(result)).not.toMatch(/private-unit-canary|csrf|ciphertext|tokenBundle/);
});
it.each(["selector", "Session", "version", "Actor", "auth_time", "CSRF", "envelope"] as const)(
  "refuses a substituted record %s rather than trusting the hook input",
  async (mode) => {
    const f = strongFixture(),
      record = insertedRecord(f);
    let candidate: ReturnType<typeof createBrowserSessionRecord>;
    if (mode === "selector")
      candidate = createBrowserSessionRecord({
        ...record,
        sessionSelectorHash: parseSelectorHash("b".repeat(64)),
      });
    else if (mode === "CSRF")
      candidate = createBrowserSessionRecord({
        ...record,
        csrfSelectorHash: parseSelectorHash("b".repeat(64)),
      });
    else if (mode === "envelope")
      candidate = createBrowserSessionRecord({
        ...record,
        encryptedSecrets: { ...record.encryptedSecrets, keyReference: "substituted-key" },
      });
    else {
      const { policy, ...fields } = record.session;
      const authenticatedAt = mode === "auth_time" ? "2026-09-10T09:59:59.000Z" : at;
      const inputActor = createIdentityActor({
        ...actor,
        actorReference: mode === "Actor" ? id(9) : id(1),
        authenticatedAt,
      });
      candidate = createBrowserSessionRecord({
        ...record,
        session: createAuthenticationSession({
          ...fields,
          actor: inputActor,
          authenticatedAt,
          sessionReference: mode === "Session" ? id(9) : id(2),
          version: mode === "version" ? 2 : 1,
          policyCode: policy.code,
          maxActiveSessions: policy.maxActiveSessions,
          idleTimeoutMinutes: policy.idleTimeoutMinutes,
          absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
        }),
      });
    }
    await expect(
      createPostgresCurrentWorkforceBrowserSessionRecordSource(f.options)(f.tx, candidate),
    ).rejects.toThrow("request denied");
  },
);
it("refuses record admission at MFA expiry and current identity withdrawal after its insert", async () => {
  const f = strongFixture(),
    record = insertedRecord(f);
  f.clock("2026-09-10T10:15:00.000Z");
  await expect(
    createPostgresCurrentWorkforceBrowserSessionRecordSource(f.options)(f.tx, record),
  ).rejects.toThrow();
  const g = strongFixture(),
    next = insertedRecord(g);
  g.afterQuery(() => g.actor(createIdentityActor({ ...actor, status: "Suspended" })));
  await expect(
    createPostgresCurrentWorkforceBrowserSessionRecordSource(g.options)(g.tx, next),
  ).rejects.toThrow();
});
it("rejects malformed record accessors before querying or running them", async () => {
  const f = strongFixture(),
    record = insertedRecord(f);
  let calls = 0;
  const candidate = { ...record };
  Object.defineProperty(candidate, "sessionSelectorHash", {
    enumerable: true,
    get() {
      calls++;
      return record.sessionSelectorHash;
    },
  });
  await expect(
    createPostgresCurrentWorkforceBrowserSessionRecordSource(f.options)(f.tx, candidate),
  ).rejects.toThrow();
  expect(calls).toBe(0);
  expect(f.sql).toHaveLength(0);
});

it("refuses hash-driven query replacement before any SQL can escape to a foreign transaction", async () => {
  const f = strongFixture(),
    foreignQuery = vi.fn(async () => ({ rows: [f.row] }));
  f.options.hasher.hash = () => {
    f.tx.query = foreignQuery;
    return parseSelectorHash("a".repeat(64));
  };
  const read = createPostgresCurrentWorkforceBrowserSessionSource(f.options);
  await expect(read(f.tx, "x".repeat(43))).rejects.toThrow("request denied");
  expect(foreignQuery).not.toHaveBeenCalled();
  expect(f.sql).toHaveLength(0);
});
