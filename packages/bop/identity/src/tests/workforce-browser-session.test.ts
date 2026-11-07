import { Buffer } from "node:buffer";
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { WorkforceBrowserSessionService } from "../application/workforce-browser-session-service.js";
import { createIdentityActor, parseCanonicalInstant } from "../contracts/identity-actor.js";
import {
  createAuthenticationSession,
  sessionPolicies,
  parseSessionVersion,
  type AuthenticationSession,
} from "../contracts/authentication-session.js";
import {
  createAuthorizationTransaction,
  createBrowserSessionRecord,
  parseAuthorizationTransactionReference,
  parseRawBrowserCredential,
  parseSelectorHash,
  type AuthorizationTransaction,
  type BrowserSessionRecord,
} from "../contracts/browser-session.js";
import {
  parseWorkforceSessionSecrets,
  type WorkforceBrowserSessionStorePort,
  type WorkforceOidcProviderPort,
} from "../contracts/workforce-browser-session.js";
import type {
  BrowserCredentialGeneratorPort,
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../application/ports/session-credential-ports.js";
const id = (n: number) => `0190ed60-0000-7000-8000-${String(n).padStart(12, "0")}`,
  initial = "2026-10-06T12:00:00.000Z",
  path = "/app/organization/brands";
const configuration = {
  environment: "controlled",
  issuer: "https://identity.invalid/",
  clientId: "controlled-workforce",
  redirectUri: "https://merchant.invalid/merchant/organization/brands/callback",
  allowedPostLoginPaths: [path, `${path}/${id(7)}`],
};
function fields(s: AuthenticationSession) {
  return {
    sessionReference: s.sessionReference,
    actor: s.actor,
    status: s.status,
    policyCode: s.policy.code,
    maxActiveSessions: s.policy.maxActiveSessions,
    idleTimeoutMinutes: s.policy.idleTimeoutMinutes,
    absoluteTimeoutMinutes: s.policy.absoluteTimeoutMinutes,
    version: s.version,
    authenticatedAt: s.authenticatedAt,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    idleExpiresAt: s.idleExpiresAt,
    absoluteExpiresAt: s.absoluteExpiresAt,
    rotatedFromSessionReference: s.rotatedFromSessionReference,
    revocationReason: s.revocationReason,
    revokedAt: s.revokedAt,
  };
}
/** Actual service and owning contract parsers, AES-GCM/nonce/HMAC/PKCE. Provider
 * and atomic store protocol are controlled; this is not real PG or Provider proof. */
function fixture() {
  let at = initial,
    counter = 1,
    uuid = 20,
    ivCounter = 1,
    evidence = 100,
    kind = "Workforce",
    logoutConfirmed = true,
    failReplacement = false,
    readLag = 0;
  const authorizations = new Map<string, AuthorizationTransaction>(),
    sessions = new Map<string, BrowserSessionRecord>(),
    key = Buffer.alloc(32, 43),
    events: string[] = [];
  const requests: Parameters<WorkforceOidcProviderPort["createAuthorizationUrl"]>[0][] = [];
  type Exchange = Awaited<ReturnType<WorkforceOidcProviderPort["exchangeCode"]>>;
  const patch: { exchange?: (value: Exchange) => Exchange } = {};
  const credentials: BrowserCredentialGeneratorPort = {
    generate: () => parseRawBrowserCredential(Buffer.alloc(32, counter++).toString("base64url")),
    generateUuidV7: () => id(uuid++),
  };
  const hasher: BrowserCredentialHasherPort = {
    hash: (value) =>
      parseSelectorHash(createHmac("sha256", Buffer.alloc(32, 51)).update(value).digest("hex")),
    equals: (a, b) => a === b,
  };
  const envelopes: SessionEnvelopeCryptoPort = {
    async encrypt(text, context) {
      const iv = Buffer.alloc(12, ivCounter++),
        cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(context));
      return {
        algorithm: "SYNTHETIC_AES_256_GCM",
        keyReference: "ephemeral-controlled-key",
        ciphertext: Buffer.concat([
          iv,
          cipher.update(text),
          cipher.final(),
          cipher.getAuthTag(),
        ]).toString("base64url"),
        encryptionContext: context,
      };
    },
    async decrypt(e, context) {
      if (e.encryptionContext !== context) throw Error("AAD mismatch");
      const bytes = Buffer.from(e.ciphertext, "base64url"),
        decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAAD(Buffer.from(context));
      decipher.setAuthTag(bytes.subarray(-16));
      const text = Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString();
      if (readLag) at = new Date(Date.parse(at) + readLag).toISOString();
      return text;
    },
  };
  const createRecord = (
    command: Parameters<WorkforceBrowserSessionStorePort["createSession"]>[0],
    rotated: string | null = null,
  ) => {
    const actor = createIdentityActor({
        ...command.actor,
        verificationLevel: "SingleFactor",
        recentMfaAt: null,
      }),
      s = createAuthenticationSession({
        sessionReference: command.sessionReference,
        actor,
        status: "Active",
        policyCode: "Privileged",
        ...{
          maxActiveSessions: sessionPolicies.Privileged.maxActiveSessions,
          idleTimeoutMinutes: 15,
          absoluteTimeoutMinutes: 480,
        },
        version: 1,
        authenticatedAt: actor.authenticatedAt,
        createdAt: command.observedAt,
        lastSeenAt: command.observedAt,
        idleExpiresAt: new Date(Date.parse(command.observedAt) + 900000).toISOString(),
        absoluteExpiresAt: new Date(Date.parse(command.observedAt) + 28800000).toISOString(),
        rotatedFromSessionReference: rotated,
        revocationReason: null,
        revokedAt: null,
      });
    return createBrowserSessionRecord({
      session: s,
      sessionSelectorHash: command.sessionSelectorHash,
      csrfSelectorHash: command.csrfSelectorHash,
      encryptedSecrets: command.encryptedSecrets,
    });
  };
  const store: WorkforceBrowserSessionStorePort = {
    async createAuthorizationTransaction(transaction) {
      authorizations.set(transaction.stateSelectorHash, transaction);
    },
    async consumeAuthorizationTransaction(command) {
      const tx = authorizations.get(command.stateSelectorHash);
      if (
        !tx ||
        tx.authCookieSelectorHash !== command.authCookieSelectorHash ||
        tx.consumedAt !== null ||
        command.consumedAt >= tx.expiresAt
      )
        return null;
      const consumed = createAuthorizationTransaction({
        ...tx,
        consumedAt: command.consumedAt,
        version: parseSessionVersion(2),
      });
      authorizations.set(command.stateSelectorHash, consumed);
      events.push("consume");
      return consumed;
    },
    async createSession(command) {
      events.push("create");
      const record = createRecord(command);
      sessions.set(command.sessionSelectorHash, record);
      return record;
    },
    async resolveSession(selector) {
      const record = sessions.get(selector);
      if (!record) return null;
      if (
        record.session.status !== "Active" ||
        at >= record.session.idleExpiresAt ||
        at >= record.session.absoluteExpiresAt
      )
        return record;
      const updated = createBrowserSessionRecord({
        ...record,
        session: createAuthenticationSession({
          ...fields(record.session),
          lastSeenAt: at,
          idleExpiresAt: new Date(Date.parse(at) + 900000).toISOString(),
        }),
      });
      sessions.set(selector, updated);
      return updated;
    },
    async replaceAfterStepUp(command) {
      events.push("replace");
      const old = sessions.get(command.currentSelectorHash);
      if (
        !old ||
        old.session.status !== "Active" ||
        old.session.sessionReference !== command.expectedSessionReference ||
        old.session.version !== command.expectedVersion ||
        old.session.actor.actorReference !== command.actor.actorReference
      )
        throw Error("controlled CAS failure");
      const record = createRecord(
        {
          sessionReference: command.nextSessionReference,
          actor: command.actor,
          policyCode: "Privileged",
          sessionSelectorHash: command.nextSelectorHash,
          csrfSelectorHash: command.nextCsrfSelectorHash,
          encryptedSecrets: command.nextEncryptedSecrets,
          observedAt: command.observedAt,
        },
        old.session.sessionReference,
      );
      const prior = parseWorkforceSessionSecrets(
          JSON.parse(
            await envelopes.decrypt(old.encryptedSecrets, old.encryptedSecrets.encryptionContext),
          ),
          configuration,
          old.session,
        ),
        next = parseWorkforceSessionSecrets(
          JSON.parse(
            await envelopes.decrypt(
              command.nextEncryptedSecrets,
              command.nextEncryptedSecrets.encryptionContext,
            ),
          ),
          configuration,
          record.session,
        );
      if (
        next.mfa.evidenceReference === prior.mfa.evidenceReference ||
        next.mfa.authorizationTransactionReference ===
          prior.mfa.authorizationTransactionReference ||
        failReplacement
      )
        throw Error("controlled owning replacement refusal");
      const revoked = createBrowserSessionRecord({
        ...old,
        session: createAuthenticationSession({
          ...fields(old.session),
          status: "Revoked",
          version: Number(old.session.version) + 1,
          revocationReason: "RiskChange",
          revokedAt: command.observedAt,
        }),
      });
      sessions.set(command.currentSelectorHash, revoked);
      sessions.set(command.nextSelectorHash, record);
      return record;
    },
    async revokeSession(command) {
      events.push("revoke");
      const old = sessions.get(command.selectorHash);
      if (!old || old.session.version !== command.expectedVersion) return null;
      const revoked = createBrowserSessionRecord({
        ...old,
        session: createAuthenticationSession({
          ...fields(old.session),
          status: "Revoked",
          version: Number(old.session.version) + 1,
          revocationReason: command.reason,
          revokedAt: command.observedAt,
        }),
      });
      sessions.set(command.selectorHash, revoked);
      return revoked.session;
    },
  };
  const provider: WorkforceOidcProviderPort = {
    createAuthorizationUrl: vi.fn(async (request) => {
      requests.push(request);
      return "https://identity.invalid/authorize";
    }),
    exchangeCode: vi.fn(async (request) => {
      events.push("exchange");
      const authenticatedAt = parseCanonicalInstant(at),
        actor = createIdentityActor({
          actorType: "User",
          actorReference: id(1),
          accountKind: kind,
          status: "Active",
          authenticationMethod: "Oidc",
          verificationLevel: "RecentMfa",
          authenticatedAt,
          recentMfaAt: authenticatedAt,
        }),
        result: Exchange = {
          actor,
          tokenBundle: "controlled-refresh-envelope",
          totp: {
            method: "Totp",
            timestampPrecision: "Millisecond",
            evidenceReference: id(evidence++),
            actorReference: id(1),
            issuer: request.issuer,
            clientId: request.clientId,
            nonce: request.nonce,
            authorizationTransactionReference: request.transactionReference,
            authenticatedAt,
            verifiedAt: authenticatedAt,
          },
        };
      return patch.exchange ? patch.exchange(result) : result;
    }),
    revokeRefreshTokens: vi.fn(async () => {
      events.push("remote-revoke");
      return logoutConfirmed ? "confirmed" : "unknown";
    }),
    createLogoutUrl: vi.fn(
      () =>
        "https://identity.invalid/logout?client_id=controlled-workforce&logout_uri=https%3A%2F%2Fmerchant.invalid%2Fapp%2Forganization%2Fbrands",
    ),
  };
  const options = {
    configuration,
    store,
    provider,
    credentials,
    hasher,
    envelopes,
    pkce: {
      challenge: (value: ReturnType<BrowserCredentialGeneratorPort["generate"]>) =>
        createHash("sha256").update(value).digest("base64url"),
    },
    now: () => at,
  };
  const service = new WorkforceBrowserSessionService(options);
  const callback = async (authCookie: unknown) => {
    const request = requests.at(-1);
    if (!request) throw Error("missing controlled authorization");
    return service.callback({ code: "controlled-code", state: request.state, authCookie });
  };
  const login = async () => {
    const start = await service.start(path),
      result = await callback(start.cookie.value),
      cookie = result.cookies[1]?.value;
    if (!cookie) throw Error("missing controlled Session cookie");
    return { result, cookie, bootstrap: await service.bootstrap(cookie) };
  };
  return {
    service,
    options,
    store,
    provider,
    patch,
    requests,
    events,
    envelopes,
    hasher,
    callback,
    login,
    authorizations,
    sessions,
    clock: (value: string) => {
      at = value;
    },
    platform: () => {
      kind = "Platform";
    },
    logoutUnknown: () => {
      logoutConfirmed = false;
    },
    logoutConfirmed: () => {
      logoutConfirmed = true;
    },
    failReplacement: () => {
      failReplacement = true;
    },
    readLag: (ms: number) => {
      readLag = ms;
    },
  };
}
describe("Workforce privileged browser Session flow", () => {
  it("consumes one actual authorization transaction and nonce into encrypted same-Session TOTP", async () => {
    const f = fixture(),
      start = await f.service.start(`${path}/${id(7)}`);
    expect(start.cookie.descriptor.name).toBe("__Host-bop-auth");
    const request = f.requests[0];
    if (!request) throw Error("missing request");
    expect(request).toMatchObject({
      prompt: "login",
      requireTotp: true,
      codeChallengeMethod: "S256",
    });
    const result = await f.callback(start.cookie.value),
      cookie = result.cookies[1]?.value,
      bootstrap = await f.service.bootstrap(cookie);
    expect(result.postLoginPath).toBe(`${path}/${id(7)}`);
    expect(result.cookies[0]).toMatchObject({
      clear: true,
      value: "",
      descriptor: { name: "__Host-bop-auth" },
    });
    expect(result.cookies[1]).toMatchObject({
      clear: false,
      descriptor: { name: "__Host-bop-merchant" },
    });
    expect(result.session.actor.accountKind).toBe("Workforce");
    expect(result.session.policy.code).toBe("Privileged");
    expect(bootstrap.recentMfa).toMatchObject({
      sessionReference: result.session.sessionReference,
      actorReference: id(1),
      authorizationTransactionReference: request.transactionReference,
      authenticatedAt: initial,
      verifiedAt: initial,
      validUntil: "2026-10-06T12:15:00.000Z",
    });
    const record = f.sessions.get(f.hasher.hash(parseRawBrowserCredential(cookie)));
    if (!record) throw Error("missing record");
    const plaintext = JSON.parse(
      await f.envelopes.decrypt(record.encryptedSecrets, record.encryptedSecrets.encryptionContext),
    );
    expect(plaintext.profile).toBe("WorkforceBrowserSessionV1");
    expect(record.encryptedSecrets.encryptionContext).toBe(
      `controlled:session:${result.session.sessionReference}:${id(1)}`,
    );
    expect(f.events.indexOf("consume")).toBeLessThan(f.events.indexOf("exchange"));
    expect(bootstrap).not.toHaveProperty("tokenBundle");
    expect(bootstrap).not.toHaveProperty("permissions");
    await expect(f.callback(start.cookie.value)).rejects.toThrow();
    expect(f.provider.exchangeCode).toHaveBeenCalledTimes(1);
  });
  it.each(["nonce", "transaction", "Actor", "issuer", "time", "extra proof"] as const)(
    "rejects mismatched genuine Provider proof %s before creating a Session",
    async (mode) => {
      const f = fixture(),
        start = await f.service.start(path);
      f.patch.exchange = (r) => ({
        ...r,
        totp: {
          ...r.totp,
          ...(mode === "nonce" ? { nonce: parseRawBrowserCredential("z".repeat(43)) } : {}),
          ...(mode === "transaction"
            ? { authorizationTransactionReference: parseAuthorizationTransactionReference(id(999)) }
            : {}),
          ...(mode === "Actor" ? { actorReference: id(999) } : {}),
          ...(mode === "issuer" ? { issuer: "https://other.invalid/" } : {}),
          ...(mode === "time"
            ? { verifiedAt: parseCanonicalInstant("2026-10-06T11:59:59.000Z") }
            : {}),
          ...(mode === "extra proof" ? { passed: true } : {}),
        },
      });
      await expect(f.callback(start.cookie.value)).rejects.toThrow();
      expect(f.sessions.size).toBe(0);
    },
  );
  it("rejects actual Platform Actor and public callback/policy injection", async () => {
    const f = fixture();
    f.platform();
    const start = await f.service.start(path);
    await expect(f.callback(start.cookie.value)).rejects.toThrow();
    expect(f.sessions.size).toBe(0);
    await expect(
      f.service.callback({
        code: "controlled",
        state: f.requests[0]?.state,
        authCookie: start.cookie.value,
        policyCode: "WorkforceStandard",
      }),
    ).rejects.toThrow();
    expect(f.provider.exchangeCode).toHaveBeenCalledTimes(1);
  });
  it.each([
    "/platform/tenants",
    "/app/organization/stores",
    "//foreign.invalid/",
    "https://foreign.invalid/",
    "/app/organization/brands?next=foreign",
  ])("allows only explicit Brand administrative post-login paths %s", async (next) => {
    const f = fixture();
    await expect(f.service.start(next)).rejects.toThrow();
    expect(f.authorizations.size).toBe(0);
    expect(f.provider.createAuthorizationUrl).not.toHaveBeenCalled();
  });
  it("requires exact CSRF for authorize and step-up while permitting readable MFA-expiry state", async () => {
    const f = fixture(),
      old = await f.login();
    await expect(
      f.service.authorize({ sessionCookie: old.cookie, csrf: "z".repeat(43) }),
    ).rejects.toThrow();
    await expect(
      f.service.startStepUp({
        sessionCookie: old.cookie,
        csrf: "z".repeat(43),
        postLoginPath: path,
      }),
    ).rejects.toThrow();
    f.clock("2026-10-06T12:14:00.000Z");
    await f.service.bootstrap(old.cookie);
    f.clock("2026-10-06T12:15:00.000Z");
    const expired = await f.service.bootstrap(old.cookie);
    expect(expired.recentMfaRequired).toBe(true);
    await expect(
      f.service.authorize({ sessionCookie: old.cookie, csrf: expired.csrf }),
    ).rejects.toThrow();
    const step = await f.service.startStepUp({
        sessionCookie: old.cookie,
        csrf: expired.csrf,
        postLoginPath: path,
      }),
      next = await f.callback(step.cookie.value);
    expect(next.session.authenticatedAt).toBe("2026-10-06T12:15:00.000Z");
    expect(next.session.rotatedFromSessionReference).toBe(old.result.session.sessionReference);
    expect((await f.service.bootstrap(next.cookies[1]?.value)).recentMfaRequired).toBe(false);
    await expect(f.service.bootstrap(old.cookie)).rejects.toThrow();
  });
  it.each(["old evidence", "wrong Actor", "store refusal"] as const)(
    "cannot replace the previous Session with %s",
    async (mode) => {
      const f = fixture(),
        old = await f.login();
      f.clock("2026-10-06T12:01:00.000Z");
      const step = await f.service.startStepUp({
        sessionCookie: old.cookie,
        csrf: old.bootstrap.csrf,
        postLoginPath: path,
      });
      if (mode === "store refusal") f.failReplacement();
      else
        f.patch.exchange = (r) =>
          mode === "old evidence"
            ? {
                ...r,
                totp: { ...r.totp, evidenceReference: old.bootstrap.recentMfa.evidenceReference },
              }
            : {
                ...r,
                actor: createIdentityActor({ ...r.actor, actorReference: id(999) }),
                totp: { ...r.totp, actorReference: id(999) },
              };
      await expect(f.callback(step.cookie.value)).rejects.toThrow();
      expect(f.sessions.size).toBe(1);
      expect((await f.service.bootstrap(old.cookie)).session.status).toBe("Active");
    },
  );
  it("returns Unknown without clearing the cookie, retains local revocation, and permits confirmed logout retry", async () => {
    const f = fixture(),
      old = await f.login();
    f.logoutUnknown();
    expect(await f.service.logout({ sessionCookie: old.cookie, csrf: old.bootstrap.csrf })).toEqual(
      { status: "Unknown", cookies: [], browserLogoutUrl: null },
    );
    expect(f.events.indexOf("revoke")).toBeLessThan(f.events.indexOf("remote-revoke"));
    await expect(f.service.bootstrap(old.cookie)).rejects.toThrow();
    expect(f.provider.createLogoutUrl).not.toHaveBeenCalled();
    f.logoutConfirmed();
    const result = await f.service.logout({ sessionCookie: old.cookie, csrf: old.bootstrap.csrf });
    expect(result).toMatchObject({
      status: "BrowserLogoutRequired",
      cookies: [{ clear: true, value: "", descriptor: { name: "__Host-bop-merchant" } }],
      browserLogoutUrl:
        "https://identity.invalid/logout?client_id=controlled-workforce&logout_uri=https%3A%2F%2Fmerchant.invalid%2Fapp%2Forganization%2Fbrands",
    });
    expect(f.provider.revokeRefreshTokens).toHaveBeenCalledTimes(2);
    expect(f.events.filter((e) => e === "revoke")).toHaveLength(1);
  });
  it("rejects malformed cookie and five-second read expiry rather than minting renewed authority", async () => {
    const f = fixture(),
      old = await f.login();
    await expect(f.service.bootstrap("short")).rejects.toThrow();
    f.readLag(5000);
    await expect(
      f.service.authorize({ sessionCookie: old.cookie, csrf: old.bootstrap.csrf }),
    ).rejects.toThrow();
  });
  it("does not exchange a code for a foreign auth cookie or state and still permits the valid one-use callback", async () => {
    const f = fixture(),
      start = await f.service.start(path),
      request = f.requests[0];
    if (!request) throw Error("missing request");
    await expect(
      f.service.callback({ code: "controlled", state: request.state, authCookie: "z".repeat(43) }),
    ).rejects.toThrow();
    await expect(
      f.service.callback({
        code: "controlled",
        state: "z".repeat(43),
        authCookie: start.cookie.value,
      }),
    ).rejects.toThrow();
    expect(f.provider.exchangeCode).not.toHaveBeenCalled();
    await f.callback(start.cookie.value);
    expect(f.provider.exchangeCode).toHaveBeenCalledTimes(1);
  });
  it.each(["authorization", "Session"] as const)(
    "rejects a Platform encrypted %s profile even with matching Workforce AAD",
    async (kind) => {
      const f = fixture();
      if (kind === "authorization") {
        const start = await f.service.start(path),
          entry = [...f.authorizations.entries()][0];
        if (!entry) throw Error("missing authorization");
        const [key, tx] = entry,
          plaintext = JSON.parse(
            await f.envelopes.decrypt(tx.encryptedSecrets, tx.encryptedSecrets.encryptionContext),
          );
        const encryptedSecrets = await f.envelopes.encrypt(
          JSON.stringify({ ...plaintext, profile: "PlatformOidcV1" }),
          tx.encryptedSecrets.encryptionContext,
        );
        f.authorizations.set(key, createAuthorizationTransaction({ ...tx, encryptedSecrets }));
        await expect(f.callback(start.cookie.value)).rejects.toThrow();
        expect(f.provider.exchangeCode).not.toHaveBeenCalled();
      } else {
        const old = await f.login(),
          selector = f.hasher.hash(parseRawBrowserCredential(old.cookie)),
          record = f.sessions.get(selector);
        if (!record) throw Error("missing Session");
        const plaintext = JSON.parse(
            await f.envelopes.decrypt(
              record.encryptedSecrets,
              record.encryptedSecrets.encryptionContext,
            ),
          ),
          encryptedSecrets = await f.envelopes.encrypt(
            JSON.stringify({ ...plaintext, profile: "PlatformBrowserSessionV1" }),
            record.encryptedSecrets.encryptionContext,
          );
        f.sessions.set(selector, createBrowserSessionRecord({ ...record, encryptedSecrets }));
        await expect(f.service.bootstrap(old.cookie)).rejects.toThrow();
      }
    },
  );
  it.each([
    { started: "2026-10-06T12:00:00.999Z", signed: initial, callback: "2026-10-06T12:00:01.000Z" },
    {
      started: "2026-10-06T12:00:00.500Z",
      signed: "2026-10-06T12:00:01.000Z",
      callback: "2026-10-06T12:00:01.200Z",
    },
  ])(
    "preserves real signed whole-second TOTP overlap without extending expiry %j",
    async (times) => {
      const f = fixture();
      f.clock(times.started);
      const start = await f.service.start(path);
      f.clock(times.callback);
      f.patch.exchange = (r) => ({
        ...r,
        actor: createIdentityActor({
          ...r.actor,
          authenticatedAt: times.signed,
          recentMfaAt: times.signed,
        }),
        totp: {
          ...r.totp,
          timestampPrecision: "Second",
          authenticatedAt: parseCanonicalInstant(times.signed),
          verifiedAt: parseCanonicalInstant(times.signed),
        },
      });
      const result = await f.callback(start.cookie.value),
        bootstrap = await f.service.bootstrap(result.cookies[1]?.value);
      expect(bootstrap.recentMfa.verifiedAt).toBe(times.signed);
      expect(bootstrap.recentMfa.validUntil).toBe(
        new Date(Date.parse(times.signed) + 900000).toISOString(),
      );
      expect(bootstrap.recentMfa).not.toHaveProperty("timestampPrecision");
    },
  );
});
