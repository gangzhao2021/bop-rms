import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizationCookie,
  BrowserSessionError,
  BrowserSessionService,
  createAuthenticationSession,
  createAuthorizationTransaction,
  createBrowserSessionRecord,
  createIdentityActor,
  merchantSessionCookie,
  parseRawBrowserCredential,
  sessionPolicies,
  type AuthorizationTransaction,
  type BrowserCredentialGeneratorPort,
  type BrowserCredentialHasherPort,
  type BrowserSessionRecord,
  type BrowserSessionStorePort,
  type CanonicalInstant,
  type CreateBrowserSessionCommand,
  type EncryptedSecretEnvelope,
  type OidcAuthorizationRequest,
  type OidcCodeExchangeRequest,
  type OidcProviderPort,
  type RawBrowserCredential,
  type RevokeBrowserSessionCommand,
  type RotateBrowserSessionCommand,
  type SelectorHash,
  type SessionEnvelopeCryptoPort,
} from "../index.js";

const UUIDS = [
  "018f6f9a-ad3e-7a11-8d01-000000000001",
  "018f6f9a-ad3e-7a11-8d01-000000000002",
  "018f6f9a-ad3e-7a11-8d01-000000000003",
];
const AT = "2026-07-29T12:00:00.000Z";
const actor = createIdentityActor({
  actorType: "User",
  actorReference: "018f6f9a-ad3e-7a11-8d01-000000000010",
  accountKind: "Workforce",
  status: "Active",
  authenticationMethod: "Oidc",
  verificationLevel: "SingleFactor",
  authenticatedAt: AT,
  recentMfaAt: null,
});

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("synthetic value unavailable");
  return value;
}

class SyntheticCredentials implements BrowserCredentialGeneratorPort {
  #credentialCounter = 1;
  #uuidCounter = 0;

  generate(): RawBrowserCredential {
    return parseRawBrowserCredential(
      Buffer.alloc(32, this.#credentialCounter++).toString("base64url"),
    );
  }

  generateUuidV7(): string {
    const value = UUIDS[this.#uuidCounter++];
    if (!value) throw new Error("synthetic UUID inventory exhausted");
    return value;
  }
}

const pepper = Buffer.alloc(32, 91);
const hasher: BrowserCredentialHasherPort = {
  hash(value) {
    return createHmac("sha256", pepper).update(value).digest("hex") as SelectorHash;
  },
  equals(left, right) {
    return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
  },
};

class SyntheticEnvelopeCrypto implements SessionEnvelopeCryptoPort {
  readonly #key = Buffer.alloc(32, 42);
  #nonceCounter = 1;

  async encrypt(plaintext: string, encryptionContext: string): Promise<EncryptedSecretEnvelope> {
    const nonce = Buffer.alloc(12, this.#nonceCounter++);
    const cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(encryptionContext));
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Object.freeze({
      algorithm: "SYNTHETIC_AES_256_GCM",
      keyReference: "synthetic-ephemeral-test-key",
      ciphertext: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url"),
      encryptionContext,
    });
  }

  async decrypt(envelope: EncryptedSecretEnvelope, encryptionContext: string): Promise<string> {
    if (
      envelope.algorithm !== "SYNTHETIC_AES_256_GCM" ||
      envelope.encryptionContext !== encryptionContext
    ) {
      throw new Error("synthetic authentication failed");
    }
    const packed = Buffer.from(envelope.ciphertext, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, packed.subarray(0, 12));
    decipher.setAAD(Buffer.from(encryptionContext));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString("utf8");
  }
}

function sessionShape(command: CreateBrowserSessionCommand) {
  const policy = sessionPolicies[command.policyCode];
  return createAuthenticationSession({
    sessionReference: command.sessionReference,
    actor: command.actor,
    status: "Active",
    policyCode: policy.code,
    maxActiveSessions: policy.maxActiveSessions,
    idleTimeoutMinutes: policy.idleTimeoutMinutes,
    absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
    version: 1,
    authenticatedAt: command.actor.authenticatedAt,
    createdAt: command.observedAt,
    lastSeenAt: command.observedAt,
    idleExpiresAt: new Date(
      Date.parse(command.observedAt) + policy.idleTimeoutMinutes * 60_000,
    ).toISOString(),
    absoluteExpiresAt: new Date(
      Date.parse(command.observedAt) + policy.absoluteTimeoutMinutes * 60_000,
    ).toISOString(),
    rotatedFromSessionReference: null,
    revocationReason: null,
    revokedAt: null,
  });
}

class SyntheticStore implements BrowserSessionStorePort {
  readonly transactions = new Map<string, AuthorizationTransaction>();
  readonly sessions = new Map<string, BrowserSessionRecord>();

  async createAuthorizationTransaction(transaction: AuthorizationTransaction): Promise<void> {
    this.transactions.set(transaction.stateSelectorHash, transaction);
  }

  async consumeAuthorizationTransaction(command: {
    stateSelectorHash: SelectorHash;
    authCookieSelectorHash: SelectorHash;
    consumedAt: CanonicalInstant;
  }): Promise<AuthorizationTransaction | null> {
    const transaction = this.transactions.get(command.stateSelectorHash);
    if (
      !transaction ||
      transaction.consumedAt !== null ||
      !hasher.equals(transaction.authCookieSelectorHash, command.authCookieSelectorHash)
    ) {
      return null;
    }
    const consumed = createAuthorizationTransaction({
      ...transaction,
      consumedAt: command.consumedAt,
      version: (transaction.version + 1) as never,
    });
    this.transactions.set(command.stateSelectorHash, consumed);
    return consumed;
  }

  async createSession(command: CreateBrowserSessionCommand): Promise<BrowserSessionRecord> {
    const record = createBrowserSessionRecord({
      session: sessionShape(command),
      sessionSelectorHash: command.sessionSelectorHash,
      csrfSelectorHash: command.csrfSelectorHash,
      encryptedSecrets: command.encryptedSecrets,
    });
    const active = [...this.sessions.values()]
      .filter(
        (candidate) =>
          candidate.session.actor.actorReference === command.actor.actorReference &&
          candidate.session.status === "Active",
      )
      .sort((left, right) => left.session.createdAt.localeCompare(right.session.createdAt));
    const maximum = sessionPolicies[command.policyCode].maxActiveSessions;
    if (active.length >= maximum) {
      this.sessions.delete(required(active[0]).sessionSelectorHash);
    }
    this.sessions.set(command.sessionSelectorHash, record);
    return record;
  }

  async resolveSession(selectorHash: SelectorHash): Promise<BrowserSessionRecord | null> {
    return this.sessions.get(selectorHash) ?? null;
  }

  async rotateSession(command: RotateBrowserSessionCommand): Promise<BrowserSessionRecord> {
    const current = this.sessions.get(command.currentSelectorHash);
    if (!current || current.session.version !== command.expectedVersion) {
      throw new BrowserSessionError("BROWSER_SESSION_VERSION_CONFLICT");
    }
    this.sessions.delete(command.currentSelectorHash);
    const session = current.session;
    const nextSession = createAuthenticationSession({
      sessionReference: command.nextSessionReference,
      actor: session.actor,
      status: "Active",
      policyCode: session.policy.code,
      maxActiveSessions: session.policy.maxActiveSessions,
      idleTimeoutMinutes: session.policy.idleTimeoutMinutes,
      absoluteTimeoutMinutes: session.policy.absoluteTimeoutMinutes,
      version: session.version + 1,
      authenticatedAt: session.authenticatedAt,
      createdAt: command.observedAt,
      lastSeenAt: command.observedAt,
      idleExpiresAt: new Date(
        Date.parse(command.observedAt) + session.policy.idleTimeoutMinutes * 60_000,
      ).toISOString(),
      absoluteExpiresAt: new Date(
        Date.parse(command.observedAt) + session.policy.absoluteTimeoutMinutes * 60_000,
      ).toISOString(),
      rotatedFromSessionReference: session.sessionReference,
      revocationReason: null,
      revokedAt: null,
    });
    const next = createBrowserSessionRecord({
      session: nextSession,
      sessionSelectorHash: command.nextSelectorHash,
      csrfSelectorHash: command.nextCsrfSelectorHash,
      encryptedSecrets: command.nextEncryptedSecrets,
    });
    this.sessions.set(command.nextSelectorHash, next);
    return next;
  }

  async revokeSession(command: RevokeBrowserSessionCommand) {
    const record = this.sessions.get(command.selectorHash);
    if (!record) return null;
    if (record.session.version !== command.expectedVersion) {
      throw new BrowserSessionError("BROWSER_SESSION_VERSION_CONFLICT");
    }
    const session = record.session;
    const revoked = createAuthenticationSession({
      sessionReference: session.sessionReference,
      actor: session.actor,
      status: "Revoked",
      policyCode: session.policy.code,
      maxActiveSessions: session.policy.maxActiveSessions,
      idleTimeoutMinutes: session.policy.idleTimeoutMinutes,
      absoluteTimeoutMinutes: session.policy.absoluteTimeoutMinutes,
      version: session.version + 1,
      authenticatedAt: session.authenticatedAt,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt,
      idleExpiresAt: session.idleExpiresAt,
      absoluteExpiresAt: session.absoluteExpiresAt,
      rotatedFromSessionReference: session.rotatedFromSessionReference,
      revocationReason: command.reason,
      revokedAt: command.observedAt,
    });
    this.sessions.set(
      command.selectorHash,
      createBrowserSessionRecord({ ...record, session: revoked }),
    );
    return revoked;
  }
}

class SyntheticProvider implements OidcProviderPort {
  authorizationRequest: OidcAuthorizationRequest | null = null;
  exchangeRequest: OidcCodeExchangeRequest | null = null;
  revokedBundles: string[] = [];

  async createAuthorizationUrl(request: OidcAuthorizationRequest): Promise<string> {
    this.authorizationRequest = request;
    return `https://synthetic-idp.invalid/authorize?request=opaque`;
  }

  async exchangeCode(request: OidcCodeExchangeRequest) {
    this.exchangeRequest = request;
    return Object.freeze({ actor, tokenBundle: "synthetic-token-bundle" });
  }

  async revokeOrLogout(encryptedTokenBundle: string): Promise<"confirmed"> {
    this.revokedBundles.push(encryptedTokenBundle);
    return "confirmed";
  }
}

function fixture() {
  const store = new SyntheticStore();
  const provider = new SyntheticProvider();
  const credentials = new SyntheticCredentials();
  const envelopes = new SyntheticEnvelopeCrypto();
  const service = new BrowserSessionService({
    configuration: {
      issuer: "https://synthetic-idp.invalid/",
      clientId: "synthetic-client",
      redirectUri: "https://merchant.invalid/auth/callback",
      allowedPostLoginPaths: ["/", "/orders"],
      environment: "synthetic-test",
    },
    store,
    provider,
    credentials,
    hasher,
    envelopes,
    pkce: {
      challenge(verifier) {
        return createHash("sha256").update(verifier).digest("base64url");
      },
    },
    now: () => AT,
  });
  return { service, store, provider };
}

describe("browser Session and same-origin BFF Domain orchestration", () => {
  it("creates a one-time PKCE transaction without persisting raw credentials", async () => {
    const { service, store, provider } = fixture();
    const result = await service.start("/orders");
    expect(result.cookie.descriptor).toEqual(authorizationCookie);
    expect(result.authorizationUrl).toBe("https://synthetic-idp.invalid/authorize?request=opaque");
    expect(provider.authorizationRequest).toMatchObject({
      codeChallengeMethod: "S256",
      redirectUri: "https://merchant.invalid/auth/callback",
    });
    const persisted = JSON.stringify([...store.transactions.values()]);
    expect(persisted).not.toContain(result.cookie.value);
    expect(persisted).not.toContain(required(provider.authorizationRequest).state);
    expect(persisted).not.toContain(required(provider.authorizationRequest).nonce);
  });

  it("consumes callback once, issues an opaque Session and enforces bound CSRF", async () => {
    const { service, provider } = fixture();
    const start = await service.start("/orders");
    const callback = await service.callback({
      code: Buffer.alloc(32, 99).toString("base64url"),
      state: required(provider.authorizationRequest).state,
      authCookie: start.cookie.value,
    });
    expect(callback.postLoginPath).toBe("/orders");
    expect(callback.cookies).toEqual([
      { descriptor: authorizationCookie, value: "", clear: true },
      expect.objectContaining({ descriptor: merchantSessionCookie, clear: false }),
    ]);
    const sessionCookie = required(callback.cookies[1]).value;
    const bootstrap = await service.bootstrap(sessionCookie);
    expect(bootstrap.session.sessionReference).toBe(callback.session.sessionReference);
    await expect(service.authorize({ sessionCookie, csrf: bootstrap.csrf })).resolves.toMatchObject(
      { status: "Active" },
    );
    await expect(
      service.authorize({
        sessionCookie,
        csrf: Buffer.alloc(32, 100).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
    await expect(
      service.callback({
        code: Buffer.alloc(32, 99).toString("base64url"),
        state: required(provider.authorizationRequest).state,
        authCookie: start.cookie.value,
      }),
    ).rejects.toMatchObject({ code: "BROWSER_SESSION_DENIED" });
  });

  it("revokes locally, asks the Provider, and always clears the Cookie", async () => {
    const { service, provider } = fixture();
    const start = await service.start("/");
    const callback = await service.callback({
      code: Buffer.alloc(32, 98).toString("base64url"),
      state: required(provider.authorizationRequest).state,
      authCookie: start.cookie.value,
    });
    const sessionCookie = required(callback.cookies[1]).value;
    await expect(service.logout(sessionCookie)).resolves.toEqual({
      descriptor: merchantSessionCookie,
      value: "",
      clear: true,
    });
    await expect(service.bootstrap(sessionCookie)).rejects.toBeDefined();
    expect(provider.revokedBundles).toEqual(["synthetic-token-bundle"]);
    await expect(service.logout(sessionCookie)).resolves.toMatchObject({ clear: true });
  });

  it("rotates Session and CSRF authority atomically and rejects the former selector", async () => {
    const { service, provider } = fixture();
    const start = await service.start("/");
    const callback = await service.callback({
      code: Buffer.alloc(32, 97).toString("base64url"),
      state: required(provider.authorizationRequest).state,
      authCookie: start.cookie.value,
    });
    const formerSelector = required(callback.cookies[1]).value;
    const formerBootstrap = await service.bootstrap(formerSelector);
    const rotated = await service.rotate(formerSelector, "PrivilegeElevation");
    expect(rotated.session.rotatedFromSessionReference).toBe(callback.session.sessionReference);
    expect(rotated.session.version).toBe(callback.session.version + 1);
    expect(rotated.cookie.value).not.toBe(formerSelector);
    await expect(service.bootstrap(formerSelector)).rejects.toMatchObject({
      code: "BROWSER_SESSION_DENIED",
    });
    const currentBootstrap = await service.bootstrap(rotated.cookie.value);
    expect(currentBootstrap.csrf).not.toBe(formerBootstrap.csrf);
  });

  it.each([
    "https://evil.invalid/",
    "//evil.invalid",
    "/orders%2f..",
    "/orders\\admin",
    "/not-allowed",
  ])("rejects unsafe or unallowlisted return path %s", async (path) => {
    await expect(fixture().service.start(path)).rejects.toMatchObject({
      code: "BROWSER_SESSION_DENIED",
    });
  });

  it("keeps public failures generic and credential-free", async () => {
    const { service } = fixture();
    const secret = Buffer.alloc(32, 77).toString("base64url");
    try {
      await service.callback({ code: secret, state: secret, authCookie: secret });
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(BrowserSessionError);
      expect(String((error as Error).message)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
    }
  });
});
