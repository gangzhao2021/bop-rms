import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAuthorizationTransaction,
  parseAuthorizationTransactionReference,
  parseRawBrowserCredential,
  parseSelectorHash,
} from "../contracts/browser-session.js";
import { parseCanonicalInstant } from "../contracts/identity-actor.js";
import { parseSessionVersion } from "../contracts/authentication-session.js";
import { parseWorkforceOnboardingInvitationBinding } from "../contracts/workforce-onboarding-invitation.js";
import type { SessionEnvelopeCryptoPort } from "../application/ports/session-credential-ports.js";
import {
  createPostgresWorkforceOnboardingAuthorizationSource,
  type WorkforceOnboardingAuthorizationSourceOptions,
} from "../infrastructure/persistence/oidc-authorization-store.js";

const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`;
const startedAt = "2026-10-06T12:00:00.000Z",
  origin = "2026-10-06T12:00:02.000Z",
  originalEnd = "2026-10-06T12:00:07.000Z",
  expiresAt = "2026-10-06T12:10:00.000Z";
const denied = { code: "BROWSER_SESSION_DENIED" };

/** Real local AES-GCM with ephemeral synthetic key material, controlled SQL and
 * a captured host protocol. This is not native row-lock, Provider or callback proof. */
async function fixture(payloadChanges: Readonly<Record<string, unknown>> = {}) {
  const configuration = {
      environment: "controlled",
      issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled",
      clientId: "controlledclient",
    },
    redirectUri = "https://merchant.invalid/merchant/organization/brands/callback",
    allowedPostLoginPaths: [string] = ["/app/organization/brands"],
    binding = parseWorkforceOnboardingInvitationBinding({
      configuration,
      invitationReference: id(2),
      originalIntentDigest: `sha256:${"a".repeat(64)}`,
      selectorHash: "b".repeat(64),
    }),
    nonce = parseRawBrowserCredential(Buffer.alloc(32, 3).toString("base64url")),
    codeVerifier = parseRawBrowserCredential(Buffer.alloc(32, 4).toString("base64url")),
    payload = {
      profile: "WorkforceOnboardingOidcV1",
      nonce,
      codeVerifier,
      startedAt,
      previous: null,
      binding,
      ...payloadChanges,
    },
    key = Buffer.alloc(32, 23);
  let ivIndex = 1,
    at = origin,
    decryptLag = 0,
    transactionId = 52,
    autocommit = false,
    isolation = "read committed",
    failQuery = false,
    failRegister = false;
  let queryHook: (() => Promise<void>) | undefined;
  const queries: string[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(plaintext, context) {
      const iv = Buffer.alloc(12, ivIndex++),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      return Object.freeze({
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "controlled-ephemeral-key",
        encryptionContext: context,
        ciphertext: Buffer.concat([
          iv,
          cipher.update(plaintext),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64url"),
      });
    },
    async decrypt(envelope, context) {
      if (envelope.encryptionContext !== context) throw new Error("controlled AAD mismatch");
      const data = Buffer.from(envelope.ciphertext, "base64url"),
        decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(data.subarray(-16));
      const text = Buffer.concat([
        decipher.update(data.subarray(12, -16)),
        decipher.final(),
      ]).toString("utf8");
      at = new Date(Date.parse(at) + decryptLag).toISOString();
      return text;
    },
  };
  const authorization = createAuthorizationTransaction({
    transactionReference: parseAuthorizationTransactionReference(id(1)),
    stateSelectorHash: parseSelectorHash("c".repeat(64)),
    authCookieSelectorHash: parseSelectorHash("d".repeat(64)),
    encryptedSecrets: await envelopes.encrypt(
      JSON.stringify(payload),
      `${configuration.environment}:oidc:${id(1)}`,
    ),
    redirectUri,
    postLoginPath: allowedPostLoginPaths[0],
    expiresAt: parseCanonicalInstant(expiresAt),
    consumedAt: parseCanonicalInstant(origin),
    version: parseSessionVersion(2),
  });
  const row: Record<string, unknown> = {
    transaction_id: authorization.transactionReference,
    state_selector_hash: authorization.stateSelectorHash,
    auth_cookie_selector_hash: authorization.authCookieSelectorHash,
    encrypted_secret: Buffer.from(authorization.encryptedSecrets.ciphertext, "base64url"),
    cipher_algorithm: authorization.encryptedSecrets.algorithm,
    key_reference: authorization.encryptedSecrets.keyReference,
    encryption_context: authorization.encryptedSecrets.encryptionContext,
    redirect_uri: authorization.redirectUri,
    post_login_path: authorization.postLoginPath,
    created_at: startedAt,
    expires_at: expiresAt,
    consumed_at: origin,
    version: 2,
    precise: true,
  };
  let databaseResult: unknown = { rows: [row] };
  const transaction = {
      async query(sql: string, values: readonly unknown[]) {
        queries.push(sql);
        if (queryHook) await queryHook();
        if (failQuery) throw new Error("controlled driver error");
        if (sql.includes("transaction_isolation"))
          return {
            rows: [
              { isolation, transaction_id: String(autocommit ? transactionId++ : transactionId) },
            ],
          };
        expect(sql).toContain("FROM bop_identity.oidc_authorization_transaction");
        expect(sql).toContain("FOR SHARE");
        expect(sql).toContain("date_trunc('milliseconds',consumed_at)");
        expect(values).toEqual([
          authorization.transactionReference,
          authorization.stateSelectorHash,
          authorization.authCookieSelectorHash,
        ]);
        return databaseResult;
      },
    },
    clock = { now: () => at };
  const options = {
    transaction,
    configuration,
    redirectUri,
    allowedPostLoginPaths,
    envelopes,
    authorization,
    binding,
    clock,
    originalObservedAt: origin,
    originalValidUntil: originalEnd,
    async registerBeforeCommit(tx, guard, final) {
      expect(tx).toBe(transaction);
      guards.push(guard);
      finals.push(final);
      if (failRegister) throw new Error("controlled closed host");
    },
  } satisfies WorkforceOnboardingAuthorizationSourceOptions;
  const source = createPostgresWorkforceOnboardingAuthorizationSource(options);
  return {
    source,
    options,
    row,
    authorization,
    binding,
    payload,
    nonce,
    codeVerifier,
    queries,
    guards,
    finals,
    envelopes,
    create: () => createPostgresWorkforceOnboardingAuthorizationSource(options),
    setNow: (value: string) => {
      at = value;
    },
    setAutocommit: () => {
      autocommit = true;
    },
    setIsolation: (value: string) => {
      isolation = value;
    },
    setTransactionId: (value: number) => {
      transactionId = value;
    },
    setResult: (value: unknown) => {
      databaseResult = value;
    },
    setDecryptLag: (value: number) => {
      decryptLag = value;
    },
    setQueryHook: (value: () => Promise<void>) => {
      queryHook = value;
    },
    failQuery: () => {
      failQuery = true;
    },
    failRegister: () => {
      failRegister = true;
    },
    guard: async () => {
      for (const guard of guards) await guard();
    },
    final: () => {
      for (const final of finals) final();
    },
  };
}

describe("current consumed Workforce onboarding authorization", () => {
  it("reads and decrypts the actual consumed row, keeps one host registration, and seals without post-COMMIT IO", async () => {
    const f = await fixture(),
      first = await f.source.hold();
    expect(first).toEqual({
      authorization: f.authorization,
      binding: f.binding,
      nonce: f.nonce,
      codeVerifier: f.codeVerifier,
      observedAt: origin,
      validUntil: originalEnd,
    });
    expect(first.authorization).not.toBe(f.authorization);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.authorization.encryptedSecrets)).toBe(true);
    expect(Object.isFrozen(first.binding.configuration)).toBe(true);
    expect(f.queries.slice(0, 2).every((q) => q.includes("transaction_isolation"))).toBe(true);
    f.setNow("2026-10-06T12:00:03.000Z");
    expect(await f.source.hold()).toEqual(first);
    expect(f.guards).toHaveLength(1);
    await f.guard();
    // Other owning guards may need this exact holder after its own async guard.
    expect(await f.source.hold()).toEqual(first);
    f.final();
    const count = f.queries.length;
    f.setNow("2026-10-06T13:00:00.000Z");
    f.options.transaction.query = async () => {
      throw new Error("no post-COMMIT SQL");
    };
    f.options.clock.now = () => {
      throw new Error("no post-COMMIT clock");
    };
    expect(() => f.source.assertFinalized()).not.toThrow();
    expect(f.queries).toHaveLength(count);
    expect(f.queries.every((q) => !/\b(?:UPDATE|INSERT|DELETE)\b/u.test(q))).toBe(true);
  });

  it.each([
    ["transaction_id", id(99)],
    ["state_selector_hash", "e".repeat(64)],
    ["auth_cookie_selector_hash", "f".repeat(64)],
    ["cipher_algorithm", "KMS_AES_256_GCM"],
    ["key_reference", "other-key"],
    ["encryption_context", `controlled:platform-oidc:${id(1)}`],
    ["redirect_uri", "https://other.invalid/callback"],
    ["post_login_path", "/other"],
    ["expires_at", "2026-10-06T12:10:00.001Z"],
    ["consumed_at", null],
    ["consumed_at", "2026-10-06T12:00:02.001Z"],
    ["created_at", "2026-10-06T12:00:00.001Z"],
    ["version", 1],
    ["version", 3],
    ["version", "2"],
    ["precise", false],
    ["precise", null],
  ])("rejects actual row mismatch %s rather than trusting the caller", async (key, value) => {
    const f = await fixture();
    f.row[String(key)] = value;
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(f.guards).toHaveLength(1);
    await expect(f.guard()).rejects.toMatchObject(denied);
    expect(() => f.source.assertFinalized()).toThrow();
  });

  it.each(["created_at", "expires_at", "consumed_at"])(
    "rejects noncanonical exact persisted %s",
    async (key) => {
      const f = await fixture();
      f.row[key] = String(f.row[key]).replace(".000Z", ".000001Z");
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    },
  );

  it("authenticates actual ciphertext and refuses tampering even when the caller matches the same corrupted bytes", async () => {
    const f = await fixture(),
      original = f.authorization.encryptedSecrets,
      data = Buffer.from(original.ciphertext, "base64url");
    data.writeUInt8(data.readUInt8(data.length - 1) ^ 1, data.length - 1);
    f.row.encrypted_secret = data;
    f.options.authorization = createAuthorizationTransaction({
      ...f.authorization,
      encryptedSecrets: { ...original, ciphertext: data.toString("base64url") },
    });
    await expect(f.create().hold()).rejects.toMatchObject(denied);
  });

  it.each([
    { profile: "WorkforceOidcV1" },
    { previous: { selectorHash: "a".repeat(64) } },
    { nonce: "short" },
    { codeVerifier: "short" },
    { startedAt: "2026-10-06T12:00:00.001Z" },
    { extra: true },
  ])(
    "rejects valid encrypted payload with wrong onboarding profile or facts %#",
    async (changes) => {
      const f = await fixture(changes);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    },
  );

  it.each(["invitationReference", "originalIntentDigest", "selectorHash", "configuration"])(
    "binds actual encrypted %s independently from the expected tuple",
    async (key) => {
      const base = await fixture(),
        changes: Record<string, unknown> = {
          invitationReference: id(98),
          originalIntentDigest: `sha256:${"0".repeat(64)}`,
          selectorHash: "0".repeat(64),
          configuration: { ...base.binding.configuration, clientId: "otherclient" },
        },
        f = await fixture({ binding: { ...base.binding, [key]: changes[key] } });
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    },
  );

  it("requires actual row presence and rejects malformed dense-page boundaries without invoking getters", async () => {
    for (const result of [{ rows: [] }, { rows: new Array(1) }, { rows: [{}, {}] }]) {
      const f = await fixture();
      f.setResult(result);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    }
    const f = await fixture(),
      getter = vi.fn(() => f.row);
    const page = Object.defineProperty([], "0", { enumerable: true, get: getter });
    f.setResult({ rows: page });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects closed-row extra fields and accessors without reading them", async () => {
    for (const accessor of [false, true]) {
      const f = await fixture(),
        getter = vi.fn(() => origin);
      if (accessor) Object.defineProperty(f.row, "consumed_at", { enumerable: true, get: getter });
      else f.row.unexpected = true;
      await expect(f.source.hold()).rejects.toMatchObject(denied);
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it("pins persisted bytes through the actual pre-COMMIT re-read", async () => {
    const f = await fixture();
    await f.source.hold();
    f.row.key_reference = "changed-after-hold";
    await expect(f.guard()).rejects.toMatchObject(denied);
    expect(() => f.final()).toThrow();
  });

  it("refuses autocommit, wrong isolation and a replaced actual transaction", async () => {
    const autocommit = await fixture();
    autocommit.setAutocommit();
    await expect(autocommit.source.hold()).rejects.toMatchObject(denied);
    expect(autocommit.queries).toHaveLength(2);
    const isolation = await fixture();
    isolation.setIsolation("repeatable read");
    await expect(isolation.source.hold()).rejects.toMatchObject(denied);
    const changed = await fixture();
    await changed.source.hold();
    changed.setTransactionId(53);
    await expect(changed.guard()).rejects.toMatchObject(denied);
  });

  it("registers the refusal guard before a driver or registration failure can be caught", async () => {
    for (const registration of [false, true]) {
      const f = await fixture();
      if (registration) f.failRegister();
      else f.failQuery();
      await expect(f.source.hold()).rejects.toMatchObject(denied);
      expect(f.guards).toHaveLength(1);
      await expect(f.guard()).rejects.toMatchObject(denied);
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    }
  });

  it("poisons a caught early final assertion and a caught concurrent re-entry", async () => {
    const early = await fixture();
    expect(() => early.source.assertFinalized()).toThrow();
    await expect(early.source.hold()).rejects.toMatchObject(denied);
    const f = await fixture();
    f.setQueryHook(async () => {
      await expect(f.source.hold()).rejects.toMatchObject(denied);
    });
    await expect(f.source.hold()).rejects.toMatchObject(denied);
    await expect(f.guard()).rejects.toMatchObject(denied);
  });

  it.each([
    "query",
    "decrypt",
    "clock",
    "configuration",
    "authorization",
    "binding",
    "paths",
    "register",
  ])("captures %s and refuses drift before COMMIT", async (port) => {
    const f = await fixture();
    await f.source.hold();
    if (port === "query") f.options.transaction.query = async () => ({ rows: [] });
    if (port === "decrypt") f.options.envelopes.decrypt = async () => JSON.stringify(f.payload);
    if (port === "clock") f.options.clock.now = () => origin;
    if (port === "configuration") f.options.configuration.clientId = "otherclient";
    if (port === "authorization")
      f.options.authorization = createAuthorizationTransaction({
        ...f.authorization,
        stateSelectorHash: parseSelectorHash("0".repeat(64)),
      });
    if (port === "binding")
      f.options.binding = parseWorkforceOnboardingInvitationBinding({
        ...f.binding,
        invitationReference: id(90),
      });
    if (port === "paths") f.options.allowedPostLoginPaths.push("/other");
    if (port === "register") f.options.registerBeforeCommit = async () => undefined;
    await expect(f.guard()).rejects.toMatchObject(denied);
  });

  it("keeps the original five-second lease across repeated holds and guards, including crypto delays", async () => {
    const f = await fixture();
    await f.source.hold();
    f.setNow("2026-10-06T12:00:06.999Z");
    expect((await f.source.hold()).validUntil).toBe(originalEnd);
    await f.guard();
    f.setNow(originalEnd);
    expect(() => f.final()).toThrow();
    const lag = await fixture();
    lag.setDecryptLag(5000);
    await expect(lag.source.hold()).rejects.toMatchObject(denied);
    const backwards = await fixture();
    await backwards.source.hold();
    backwards.setNow(startedAt);
    await expect(backwards.guard()).rejects.toMatchObject(denied);
  });

  it("shortens authority to the original authorization expiry", async () => {
    const f = await fixture();
    f.options.originalObservedAt = "2026-10-06T12:09:59.000Z";
    f.options.originalValidUntil = "2026-10-06T12:10:04.000Z";
    f.setNow(f.options.originalObservedAt);
    const source = f.create();
    expect((await source.hold()).validUntil).toBe(expiresAt);
    await f.guard();
    f.setNow(expiresAt);
    expect(() => f.final()).toThrow();
  });

  it("requires the real asynchronous guard before finalization and rejects duplicate final/late reads", async () => {
    const f = await fixture();
    await f.source.hold();
    expect(() => f.final()).toThrow();
    await expect(f.guard()).rejects.toMatchObject(denied);
    const done = await fixture();
    await done.source.hold();
    await done.guard();
    done.final();
    await expect(done.source.hold()).rejects.toMatchObject(denied);
    expect(() => done.source.assertFinalized()).toThrow();
  });

  it("rejects caller-side unconsumed, unsupported or mismatched configuration before a source can be used", async () => {
    const f = await fixture();
    const bad: Partial<WorkforceOnboardingAuthorizationSourceOptions>[] = [
      { originalValidUntil: "2026-10-06T12:00:07.001Z" },
      { originalValidUntil: origin },
      { redirectUri: "http://merchant.invalid/callback" },
      { allowedPostLoginPaths: ["//other.invalid"] },
      { configuration: { ...f.options.configuration, environment: "other" } },
      {
        authorization: createAuthorizationTransaction({
          ...f.authorization,
          consumedAt: null,
          version: parseSessionVersion(1),
        }),
      },
      {
        authorization: createAuthorizationTransaction({
          ...f.authorization,
          consumedAt: parseCanonicalInstant(expiresAt),
        }),
      },
    ];
    for (const patch of bad)
      expect(() =>
        createPostgresWorkforceOnboardingAuthorizationSource({ ...f.options, ...patch }),
      ).toThrow();
    expect(f.queries).toHaveLength(0);
  });
});
