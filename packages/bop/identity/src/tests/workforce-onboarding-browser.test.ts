import type { WorkforceOnboardingBrowserPort } from "../application/ports/workforce-onboarding-browser-port.js";
import { parseWorkforceOnboardingInvitationBinding } from "../contracts/workforce-onboarding-invitation.js";
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
  issuer: "https://cognito-idp.ca-central-1.amazonaws.com/ca-central-1_Controlled1",
  clientId: "controlledworkforce",
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
function fixture(enabled = true) {
  let at = initial,
    counter = 1,
    uuid = 20,
    ivCounter = 1,
    evidence = 100,
    kind = "Workforce",
    logoutConfirmed = true,
    failReplacement = false,
    readLag = 0,
    encryptionLag = 0;
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
      if (encryptionLag) at = new Date(Date.parse(at) + encryptionLag).toISOString();
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
        "https://identity.invalid/logout?client_id=controlledworkforce&logout_uri=https%3A%2F%2Fmerchant.invalid%2Fapp%2Forganization%2Fbrands",
    ),
  };
  // Provider and completion are controlled protocol boundaries; crypto and record parsers are real.
  const binding = parseWorkforceOnboardingInvitationBinding({
    configuration: {
      environment: configuration.environment,
      issuer: configuration.issuer,
      clientId: configuration.clientId,
    },
    invitationReference: id(200),
    originalIntentDigest: `sha256:${"a".repeat(64)}`,
    selectorHash: hasher.hash(credentials.generate()),
  });
  const onboarding: WorkforceOnboardingBrowserPort = {
    resolveInvitation: vi.fn(async () => ({
      binding,
      observedAt: at,
      validUntil: new Date(Date.parse(at) + 5000).toISOString(),
    })),
    exchangeCode: vi.fn(async ({ request }) => {
      events.push("onboarding-exchange");
      return {
        ...(await provider.exchangeCode(request)),
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 5000).toISOString(),
      };
    }),
    complete: vi.fn(async ({ command }) => {
      events.push("complete");
      const record = createRecord(command);
      sessions.set(command.sessionSelectorHash, record);
      return record;
    }),
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
  const service = new WorkforceBrowserSessionService({
    ...options,
    ...(enabled ? { workforceOnboarding: onboarding } : {}),
  });
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
    onboarding,
    binding,
    credentials,
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
    encryptionLag: (ms: number) => {
      encryptionLag = ms;
    },
    readLag: (ms: number) => {
      readLag = ms;
    },
  };
}

async function invited(f: ReturnType<typeof fixture>) {
  return f.service.startInvitation({ secret: f.credentials.generate(), postLoginPath: path });
}
async function alterAuthorization(
  f: ReturnType<typeof fixture>,
  change: (value: Record<string, unknown>) => Record<string, unknown>,
) {
  const entry = [...f.authorizations.entries()][0];
  if (!entry) throw Error("missing controlled authorization");
  const [hash, record] = entry;
  const payload = JSON.parse(
    await f.envelopes.decrypt(record.encryptedSecrets, record.encryptedSecrets.encryptionContext),
  );
  f.authorizations.set(
    hash,
    createAuthorizationTransaction({
      ...record,
      encryptedSecrets: await f.envelopes.encrypt(
        JSON.stringify(change(payload)),
        record.encryptedSecrets.encryptionContext,
      ),
    }),
  );
}
describe("Workforce invitation browser protocol (controlled owner ports)", () => {
  it("keeps invitation capability in encrypted OIDC storage and out of browser URL/response", async () => {
    const f = fixture(),
      start = await invited(f);
    expect(Object.keys(start).sort()).toEqual(["authorizationUrl", "cookie"]);
    expect(JSON.stringify(start)).not.toContain(f.binding.selectorHash);
    expect(JSON.stringify(f.requests)).not.toContain(f.binding.invitationReference);
    const authorization = [...f.authorizations.values()][0];
    if (!authorization) throw Error("missing authorization");
    const payload = JSON.parse(
      await f.envelopes.decrypt(
        authorization.encryptedSecrets,
        authorization.encryptedSecrets.encryptionContext,
      ),
    );
    expect(payload).toMatchObject({
      profile: "WorkforceOnboardingOidcV1",
      previous: null,
      binding: f.binding,
    });
    expect(authorization.encryptedSecrets.ciphertext).not.toContain(f.binding.selectorHash);
  });
  it("passes the exact consumed transaction, binding and fresh same-Session proof to completion once", async () => {
    const f = fixture(),
      start = await invited(f),
      result = await f.callback(start.cookie.value);
    const consumed = [...f.authorizations.values()][0];
    if (!consumed) throw Error("missing consumed authorization");
    const exchange = vi.mocked(f.onboarding.exchangeCode).mock.calls[0]?.[0];
    const completion = vi.mocked(f.onboarding.complete).mock.calls[0]?.[0];
    if (!exchange || !completion) throw Error("missing controlled owner call");
    expect(exchange.authorization).toBe(consumed);
    expect(completion.authorization).toBe(consumed);
    expect(consumed).toMatchObject({ version: 2, consumedAt: initial });
    expect(completion.binding).toEqual(f.binding);
    expect(completion.totp.authorizationTransactionReference).toBe(consumed.transactionReference);
    expect(completion.totp.nonce).toBe(exchange.request.nonce);
    expect(completion.command.actor.accountKind).toBe("Workforce");
    expect(completion.command.sessionReference).toBe(result.session.sessionReference);
    expect(f.events).toEqual(["consume", "onboarding-exchange", "exchange", "complete"]);
    expect(result.cookies[1]?.descriptor.name).toBe("__Host-bop-merchant");
    await expect(f.callback(start.cookie.value)).rejects.toThrow();
    expect(f.onboarding.complete).toHaveBeenCalledTimes(1);
  });
  it("never routes ordinary login or step-up through enrollment", async () => {
    const f = fixture(),
      login = await f.login();
    const start = await f.service.startStepUp({
      sessionCookie: login.cookie,
      csrf: login.bootstrap.csrf,
      postLoginPath: path,
    });
    await f.callback(start.cookie.value);
    expect(f.onboarding.resolveInvitation).not.toHaveBeenCalled();
    expect(f.onboarding.exchangeCode).not.toHaveBeenCalled();
    expect(f.onboarding.complete).not.toHaveBeenCalled();
    expect(f.events).toContain("create");
    expect(f.events).toContain("replace");
  });
  it("does not fall back when onboarding mode is absent, including an encrypted onboarding callback", async () => {
    const f = fixture(false);
    await expect(invited(f)).rejects.toThrow();
    expect(f.authorizations.size).toBe(0);
    const start = await f.service.start(path);
    await alterAuthorization(f, (p) => ({
      ...p,
      profile: "WorkforceOnboardingOidcV1",
      binding: f.binding,
    }));
    await expect(f.callback(start.cookie.value)).rejects.toThrow();
    expect(f.events).toEqual(["consume"]);
    expect(f.sessions.size).toBe(0);
  });
  it.each(["environment", "issuer", "clientId"] as const)(
    "refuses foreign encrypted binding %s after consumption without exchange",
    async (key) => {
      const f = fixture(),
        start = await invited(f);
      await alterAuthorization(f, (p) => ({
        ...p,
        binding: {
          ...f.binding,
          configuration: {
            ...f.binding.configuration,
            [key]: key === "issuer" ? "https://foreign.invalid/" : "foreign",
          },
        },
      }));
      await expect(f.callback(start.cookie.value)).rejects.toThrow();
      expect(f.events).toEqual(["consume"]);
      expect(f.onboarding.complete).not.toHaveBeenCalled();
    },
  );
  it.each(["extra", "previous"])(
    "refuses malformed/old-Session onboarding payload %s without ordinary fallback",
    async (mode) => {
      const f = fixture(),
        start = await invited(f);
      await alterAuthorization(f, (p) =>
        mode === "extra"
          ? { ...p, binding: { ...f.binding, unexpected: true } }
          : {
              ...p,
              previous: {
                selectorHash: f.binding.selectorHash,
                sessionReference: id(300),
                version: 1,
                actorReference: id(1),
              },
            },
      );
      await expect(f.callback(start.cookie.value)).rejects.toThrow();
      expect(f.events).toEqual(["consume"]);
      expect(f.sessions.size).toBe(0);
    },
  );
  it.each(["nonce", "transaction", "stale"])(
    "rejects mismatched or stale actual TOTP %s before completion",
    async (mode) => {
      const f = fixture(),
        start = await invited(f);
      f.patch.exchange = (value) => ({
        ...value,
        totp: {
          ...value.totp,
          ...(mode === "nonce"
            ? { nonce: f.credentials.generate() }
            : mode === "transaction"
              ? {
                  authorizationTransactionReference: parseAuthorizationTransactionReference(
                    id(400),
                  ),
                }
              : { verifiedAt: parseCanonicalInstant("2026-10-06T11:59:59.999Z") }),
        },
      });
      await expect(f.callback(start.cookie.value)).rejects.toThrow();
      expect(f.onboarding.complete).not.toHaveBeenCalled();
      expect(f.sessions.size).toBe(0);
      expect(f.events).not.toContain("create");
    },
  );
  it("rejects provider expiry during real Session encryption before completion", async () => {
    const f = fixture(),
      start = await invited(f);
    vi.mocked(f.onboarding.exchangeCode).mockImplementation(async ({ request }) => {
      const result = await f.provider.exchangeCode(request);
      f.encryptionLag(1);
      return { ...result, observedAt: initial, validUntil: "2026-10-06T12:00:00.001Z" };
    });
    await expect(f.callback(start.cookie.value)).rejects.toThrow();
    expect(f.onboarding.complete).not.toHaveBeenCalled();
    expect(f.sessions.size).toBe(0);
  });
  it("does not return cookies or call ordinary storage if completion refuses", async () => {
    const f = fixture(),
      start = await invited(f);
    vi.mocked(f.onboarding.complete).mockRejectedValue(
      Error("controlled owning qualification refusal"),
    );
    await expect(f.callback(start.cookie.value)).rejects.toThrow("request denied");
    expect(f.onboarding.complete).toHaveBeenCalledTimes(1);
    expect(f.sessions.size).toBe(0);
    expect(f.events).not.toContain("create");
    await expect(f.callback(start.cookie.value)).rejects.toThrow();
    expect(f.onboarding.complete).toHaveBeenCalledTimes(1);
  });
});

describe("Invitation observation boundaries", () => {
  it("refuses a foreign invitation before creating an OIDC transaction", async () => {
    const f = fixture();
    vi.mocked(f.onboarding.resolveInvitation).mockResolvedValue({
      binding: { ...f.binding, configuration: { ...f.binding.configuration, clientId: "foreign" } },
      observedAt: initial,
      validUntil: "2026-10-06T12:00:05.000Z",
    });
    await expect(invited(f)).rejects.toThrow("request denied");
    expect(f.authorizations.size).toBe(0);
    expect(f.requests).toHaveLength(0);
  });
  it.each(["expired", "extended", "future"])(
    "rejects %s Provider observation without allocating a Session",
    async (mode) => {
      const f = fixture(),
        start = await invited(f);
      vi.mocked(f.onboarding.exchangeCode).mockImplementation(async ({ request }) => ({
        ...(await f.provider.exchangeCode(request)),
        observedAt: mode === "future" ? "2026-10-06T12:00:00.001Z" : initial,
        validUntil: mode === "expired" ? initial : "2026-10-06T12:00:05.001Z",
      }));
      await expect(f.callback(start.cookie.value)).rejects.toThrow("request denied");
      expect(f.onboarding.complete).not.toHaveBeenCalled();
      expect(f.sessions.size).toBe(0);
    },
  );
});
