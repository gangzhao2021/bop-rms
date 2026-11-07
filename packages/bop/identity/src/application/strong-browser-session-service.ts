import { parseSessionReference, parseSessionVersion } from "../contracts/authentication-session.js";
import {
  BrowserSessionError,
  createAuthorizationTransaction,
  parseAuthorizationTransactionReference,
  parseExactHttpsUri,
  parsePostLoginPath,
  parseRawBrowserCredential,
  parseSelectorHash,
  type BrowserSessionConfiguration,
} from "../contracts/browser-session.js";
import {
  parseWorkforceOnboardingInvitationBinding,
  type WorkforceOnboardingInvitationBinding,
} from "../contracts/workforce-onboarding-invitation.js";
import type { WorkforceOnboardingBrowserPort } from "./ports/workforce-onboarding-browser-port.js";
import { parseCanonicalInstant, readClosedRecord } from "../contracts/identity-actor.js";
import {
  assertPlatformSessionCurrent,
  parsePlatformActor,
  parsePlatformSessionMfa,
  parsePlatformSessionSecrets,
  platformAuthorizationContext,
  platformAuthorizationCookie,
  platformSessionContext,
  platformSessionCookie,
  platformSessionDenied as denied,
  type PlatformBrowserCookieMutation,
  type PlatformBrowserSessionStorePort,
  type PlatformOidcProviderPort,
} from "../contracts/platform-browser-session.js";
import type {
  BrowserCredentialGeneratorPort,
  BrowserCredentialHasherPort,
  PkcePort,
  SessionEnvelopeCryptoPort,
} from "./ports/session-credential-ports.js";

export interface StrongBrowserSessionServiceOptions {
  readonly configuration: BrowserSessionConfiguration;
  readonly store: PlatformBrowserSessionStorePort | WorkforceBrowserSessionStorePort;
  readonly provider: PlatformOidcProviderPort | WorkforceOidcProviderPort;
  readonly credentials: BrowserCredentialGeneratorPort;
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly pkce: PkcePort;
  readonly now: () => string;
  readonly workforceOnboarding?: WorkforceOnboardingBrowserPort;
}
const decode = (value: string): unknown => {
  if (typeof value !== "string" || value.length > 16_384) return denied();
  return JSON.parse(value);
};
interface Previous {
  readonly selectorHash: string;
  readonly sessionReference: string;
  readonly version: number;
  readonly actorReference: string;
}

import {
  assertWorkforceSessionCurrent,
  parseWorkforceActor,
  parseWorkforceSessionMfa,
  parseWorkforceSessionSecrets,
  workforceAuthorizationContext,
  workforceAuthorizationCookie,
  workforceSessionContext,
  workforceSessionCookie,
  type WorkforceBrowserCookieMutation,
  type WorkforceBrowserSessionStorePort,
  type WorkforceOidcProviderPort,
} from "../contracts/workforce-browser-session.js";

type StrongKind = "Platform" | "Workforce";
type StrongCookie<K extends StrongKind> = K extends "Platform"
  ? PlatformBrowserCookieMutation
  : WorkforceBrowserCookieMutation;
const profiles = Object.freeze({
  Platform: Object.freeze({
    parseActor: parsePlatformActor,
    parseMfa: parsePlatformSessionMfa,
    parseSecrets: parsePlatformSessionSecrets,
    assertCurrent: assertPlatformSessionCurrent,
    authorizationContext: platformAuthorizationContext,
    sessionContext: platformSessionContext,
    authorizationCookie: platformAuthorizationCookie,
    sessionCookie: platformSessionCookie,
    authorizationProfile: "PlatformOidcV1",
    sessionProfile: "PlatformBrowserSessionV1",
  }),
  Workforce: Object.freeze({
    parseActor: parseWorkforceActor,
    parseMfa: parseWorkforceSessionMfa,
    parseSecrets: parseWorkforceSessionSecrets,
    assertCurrent: assertWorkforceSessionCurrent,
    authorizationContext: workforceAuthorizationContext,
    sessionContext: workforceSessionContext,
    authorizationCookie: workforceAuthorizationCookie,
    sessionCookie: workforceSessionCookie,
    authorizationProfile: "WorkforceOidcV1",
    sessionProfile: "WorkforceBrowserSessionV1",
  }),
});
/** Private lifecycle shared by the two fixed privileged browser entries. Authentication never supplies application permissions. */
export class StrongBrowserSessionService<K extends StrongKind> {
  readonly #configuration: BrowserSessionConfiguration;
  readonly #profile: (typeof profiles)[StrongKind];
  readonly #options: StrongBrowserSessionServiceOptions;
  readonly #onboarding: WorkforceOnboardingBrowserPort | undefined;
  constructor(options: StrongBrowserSessionServiceOptions, kind: K) {
    if (kind !== "Platform" && kind !== "Workforce") denied();
    this.#profile = profiles[kind];
    const onboarding = options.workforceOnboarding;
    if (onboarding !== undefined) {
      if (kind !== "Workforce") denied();
      readClosedRecord(onboarding, ["resolveInvitation", "exchangeCode", "complete"]);
      if (
        [onboarding.resolveInvitation, onboarding.exchangeCode, onboarding.complete].some(
          (p) => typeof p !== "function",
        )
      )
        denied();
      this.#onboarding = Object.freeze({
        resolveInvitation: onboarding.resolveInvitation.bind(onboarding),
        exchangeCode: onboarding.exchangeCode.bind(onboarding),
        complete: onboarding.complete.bind(onboarding),
      });
    }
    const c = options.configuration;
    if (
      !/^[a-z][a-z0-9-]{0,63}$/u.test(c.environment) ||
      !/^[A-Za-z0-9._~-]{1,255}$/u.test(c.clientId) ||
      !c.allowedPostLoginPaths.length ||
      c.allowedPostLoginPaths.some(
        (p) =>
          !(kind === "Platform"
            ? p.startsWith("/platform/")
            : /^\/app\/organization\/brands(?:\/[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/u.test(
                p,
              )) || parsePostLoginPath(p, c.allowedPostLoginPaths) !== p,
      )
    )
      denied();
    this.#configuration = Object.freeze({
      ...c,
      issuer: parseExactHttpsUri(c.issuer),
      redirectUri: parseExactHttpsUri(c.redirectUri),
      allowedPostLoginPaths: Object.freeze([...c.allowedPostLoginPaths]),
    });
    const store = options.store,
      provider = options.provider;
    this.#options = Object.freeze({
      ...options,
      store: Object.freeze({
        createAuthorizationTransaction: store.createAuthorizationTransaction.bind(store),
        consumeAuthorizationTransaction: store.consumeAuthorizationTransaction.bind(store),
        createSession: store.createSession.bind(store),
        resolveSession: store.resolveSession.bind(store),
        replaceAfterStepUp: store.replaceAfterStepUp.bind(store),
        revokeSession: store.revokeSession.bind(store),
      }),
      provider: Object.freeze({
        createAuthorizationUrl: provider.createAuthorizationUrl.bind(provider),
        exchangeCode: provider.exchangeCode.bind(provider),
        revokeRefreshTokens: provider.revokeRefreshTokens.bind(provider),
        createLogoutUrl: provider.createLogoutUrl.bind(provider),
      }),
      hasher: Object.freeze({
        hash: options.hasher.hash.bind(options.hasher),
        equals: options.hasher.equals.bind(options.hasher),
      }),
      envelopes: Object.freeze({
        encrypt: options.envelopes.encrypt.bind(options.envelopes),
        decrypt: options.envelopes.decrypt.bind(options.envelopes),
      }),
      credentials: Object.freeze({
        generate: options.credentials.generate.bind(options.credentials),
        generateUuidV7: options.credentials.generateUuidV7.bind(options.credentials),
      }),
      pkce: Object.freeze({ challenge: options.pkce.challenge.bind(options.pkce) }),
    });
  }
  #cookie(
    kind: "authorization" | "session",
    value: PlatformBrowserCookieMutation["value"],
    clear: boolean,
  ): StrongCookie<K> {
    return Object.freeze({
      descriptor:
        kind === "authorization" ? this.#profile.authorizationCookie : this.#profile.sessionCookie,
      value,
      clear,
    }) as StrongCookie<K>;
  }
  #now() {
    return parseCanonicalInstant(this.#options.now());
  }
  async #safe<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_VERSION_CONFLICT")
        throw error;
      return denied();
    }
  }
  async #start(
    pathInput: unknown,
    previous: Previous | null,
    binding?: WorkforceOnboardingInvitationBinding,
  ) {
    const o = this.#options,
      c = this.#configuration,
      startedAt = this.#now();
    const postLoginPath = parsePostLoginPath(pathInput, c.allowedPostLoginPaths);
    const authCookie = o.credentials.generate(),
      state = o.credentials.generate(),
      nonce = o.credentials.generate(),
      codeVerifier = o.credentials.generate(),
      transactionReference = parseAuthorizationTransactionReference(o.credentials.generateUuidV7());
    const encryptedSecrets = await o.envelopes.encrypt(
      JSON.stringify({
        profile: binding ? "WorkforceOnboardingOidcV1" : this.#profile.authorizationProfile,
        nonce,
        codeVerifier,
        startedAt,
        previous,
        ...(binding ? { binding } : {}),
      }),
      this.#profile.authorizationContext(c.environment, transactionReference),
    );
    await o.store.createAuthorizationTransaction(
      createAuthorizationTransaction({
        transactionReference,
        stateSelectorHash: o.hasher.hash(state),
        authCookieSelectorHash: o.hasher.hash(authCookie),
        encryptedSecrets,
        redirectUri: c.redirectUri,
        postLoginPath,
        expiresAt: parseCanonicalInstant(new Date(Date.parse(startedAt) + 600_000).toISOString()),
        consumedAt: null,
        version: parseSessionVersion(1),
      }),
    );
    const authorizationUrl = parseExactHttpsUri(
      await o.provider.createAuthorizationUrl({
        issuer: c.issuer,
        clientId: c.clientId,
        redirectUri: c.redirectUri,
        state,
        nonce,
        codeChallenge: o.pkce.challenge(codeVerifier),
        codeChallengeMethod: "S256",
        prompt: "login",
        requireTotp: true,
        transactionReference,
      }),
    );
    return Object.freeze({
      authorizationUrl,
      cookie: this.#cookie("authorization", authCookie, false),
    });
  }
  start(postLoginPath: unknown) {
    return this.#safe(() => this.#start(postLoginPath, null));
  }
  protected startInvited(input: unknown) {
    return this.#safe(async () => {
      const port = this.#onboarding;
      if (!port) return denied();
      const r = readClosedRecord(input, ["secret", "postLoginPath"]),
        observedAt = this.#now(),
        validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
      const packet = readClosedRecord(
        await port.resolveInvitation({
          secret: parseRawBrowserCredential(r.secret),
          observedAt,
          validUntil,
        }),
        ["binding", "observedAt", "validUntil"],
      );
      const binding = parseWorkforceOnboardingInvitationBinding(packet.binding),
        observed = parseCanonicalInstant(packet.observedAt),
        until = parseCanonicalInstant(packet.validUntil),
        at = this.#now();
      if (
        observed !== observedAt ||
        at < observed ||
        until > validUntil ||
        at >= until ||
        binding.configuration.environment !== this.#configuration.environment ||
        binding.configuration.issuer !== this.#configuration.issuer ||
        binding.configuration.clientId !== this.#configuration.clientId
      )
        return denied();
      return this.#start(r.postLoginPath, null, binding);
    });
  }
  async #read(cookie: unknown, requireRecentMfa: boolean, csrfInput?: unknown) {
    const o = this.#options,
      startedAt = this.#now();
    const selectorHash = o.hasher.hash(parseRawBrowserCredential(cookie));
    const record = await o.store.resolveSession(selectorHash);
    if (!record || record.session.actor.actorReference === null) return denied();
    const context = this.#profile.sessionContext(
      this.#configuration.environment,
      record.session.sessionReference,
      record.session.actor.actorReference,
    );
    if (record.encryptedSecrets.encryptionContext !== context) return denied();
    const secrets = this.#profile.parseSecrets(
      decode(await o.envelopes.decrypt(record.encryptedSecrets, context)),
      this.#configuration,
      record.session,
    );
    if (
      !o.hasher.equals(o.hasher.hash(secrets.csrf), record.csrfSelectorHash) ||
      (csrfInput !== undefined &&
        !o.hasher.equals(
          o.hasher.hash(parseRawBrowserCredential(csrfInput)),
          record.csrfSelectorHash,
        ))
    )
      return denied();
    const now = this.#now();
    if (now < startedAt || Date.parse(now) >= Date.parse(startedAt) + 5000) return denied();
    this.#profile.assertCurrent(record.session, secrets.mfa, now, requireRecentMfa);
    const validUntil = parseCanonicalInstant(
      new Date(
        Math.min(
          Date.parse(startedAt) + 5000,
          Date.parse(record.session.idleExpiresAt),
          Date.parse(record.session.absoluteExpiresAt),
          ...(requireRecentMfa ? [Date.parse(secrets.mfa.validUntil)] : []),
        ),
      ).toISOString(),
    );
    return { record, secrets, selectorHash, observedAt: startedAt, validUntil };
  }
  bootstrap(sessionCookie: unknown) {
    return this.#safe(async () => {
      const r = await this.#read(sessionCookie, false);
      return Object.freeze({
        session: r.record.session,
        csrf: r.secrets.csrf,
        recentMfa: r.secrets.mfa,
        recentMfaRequired: this.#now() >= r.secrets.mfa.validUntil,
        observedAt: r.observedAt,
        validUntil: r.validUntil,
      });
    });
  }
  authorize(input: unknown) {
    return this.#safe(async () => {
      const r = readClosedRecord(input, ["sessionCookie", "csrf"]);
      const current = await this.#read(r.sessionCookie, true, r.csrf);
      return Object.freeze({
        session: current.record.session,
        recentMfa: current.secrets.mfa,
        observedAt: current.observedAt,
        validUntil: current.validUntil,
      });
    });
  }
  startStepUp(input: unknown) {
    return this.#safe(async () => {
      const r = readClosedRecord(input, ["sessionCookie", "csrf", "postLoginPath"]);
      const current = await this.#read(r.sessionCookie, false, r.csrf),
        s = current.record.session;
      if (s.actor.actorReference === null) return denied();
      return this.#start(r.postLoginPath, {
        selectorHash: current.selectorHash,
        sessionReference: s.sessionReference,
        version: s.version,
        actorReference: s.actor.actorReference,
      });
    });
  }
  callback(input: unknown) {
    return this.#safe(async () => {
      const r = readClosedRecord(input, ["code", "state", "authCookie"]),
        o = this.#options,
        c = this.#configuration;
      if (typeof r.code !== "string" || !/^[\x21-\x7e]{1,4096}$/u.test(r.code)) return denied();
      const consumedAt = this.#now();
      const transaction = await o.store.consumeAuthorizationTransaction({
        stateSelectorHash: o.hasher.hash(parseRawBrowserCredential(r.state)),
        authCookieSelectorHash: o.hasher.hash(parseRawBrowserCredential(r.authCookie)),
        consumedAt,
      });
      if (
        !transaction ||
        transaction.consumedAt !== consumedAt ||
        transaction.version !== 2 ||
        transaction.redirectUri !== c.redirectUri ||
        transaction.encryptedSecrets.encryptionContext !==
          this.#profile.authorizationContext(c.environment, transaction.transactionReference)
      )
        return denied();
      const decoded = decode(
        await o.envelopes.decrypt(
          transaction.encryptedSecrets,
          this.#profile.authorizationContext(c.environment, transaction.transactionReference),
        ),
      );
      const onboarding =
        decoded !== null &&
        typeof decoded === "object" &&
        Object.getOwnPropertyDescriptor(decoded, "profile")?.value === "WorkforceOnboardingOidcV1";
      if (onboarding && !this.#onboarding) return denied();
      const secrets = readClosedRecord(decoded, [
        "profile",
        "nonce",
        "codeVerifier",
        "startedAt",
        "previous",
        ...(onboarding ? ["binding"] : []),
      ]);
      const binding = onboarding
        ? parseWorkforceOnboardingInvitationBinding(secrets.binding)
        : null;
      const startedAt = parseCanonicalInstant(secrets.startedAt),
        nonce = parseRawBrowserCredential(secrets.nonce);
      if (
        secrets.profile !==
          (onboarding ? "WorkforceOnboardingOidcV1" : this.#profile.authorizationProfile) ||
        (onboarding && secrets.previous !== null) ||
        (binding !== null &&
          (binding.configuration.environment !== c.environment ||
            binding.configuration.issuer !== c.issuer ||
            binding.configuration.clientId !== c.clientId)) ||
        startedAt > consumedAt ||
        Date.parse(transaction.expiresAt) !== Date.parse(startedAt) + 600_000 ||
        consumedAt >= transaction.expiresAt
      )
        return denied();
      const previous =
        secrets.previous === null
          ? null
          : readClosedRecord(secrets.previous, [
              "selectorHash",
              "sessionReference",
              "version",
              "actorReference",
            ]);
      const exchangeRequest = {
        issuer: c.issuer,
        clientId: c.clientId,
        redirectUri: c.redirectUri,
        code: r.code,
        nonce,
        codeVerifier: parseRawBrowserCredential(secrets.codeVerifier),
        prompt: "login" as const,
        requireTotp: true as const,
        transactionReference: transaction.transactionReference,
      };
      const exchange = readClosedRecord(
        binding && this.#onboarding
          ? await this.#onboarding.exchangeCode({
              request: exchangeRequest,
              authorization: transaction,
              binding,
            })
          : await o.provider.exchangeCode(exchangeRequest),
        ["actor", "tokenBundle", "totp", ...(onboarding ? ["observedAt", "validUntil"] : [])],
      );
      const actual = this.#profile.parseActor(exchange.actor);
      const proof = readClosedRecord(exchange.totp, [
        "method",
        "timestampPrecision",
        "evidenceReference",
        "actorReference",
        "issuer",
        "clientId",
        "authorizationTransactionReference",
        "nonce",
        "authenticatedAt",
        "verifiedAt",
      ]);
      const verifiedAt = parseCanonicalInstant(proof.verifiedAt),
        authenticatedAt = parseCanonicalInstant(proof.authenticatedAt),
        observedAt = this.#now();
      const freshTimestamp =
        proof.timestampPrecision === "Millisecond"
          ? verifiedAt >= startedAt
          : proof.timestampPrecision === "Second" &&
            verifiedAt === authenticatedAt &&
            Date.parse(verifiedAt) % 1000 === 0 &&
            Date.parse(verifiedAt) + 1000 > Date.parse(startedAt);
      if (
        observedAt < consumedAt ||
        observedAt >= transaction.expiresAt ||
        proof.method !== "Totp" ||
        proof.issuer !== c.issuer ||
        proof.clientId !== c.clientId ||
        proof.nonce !== nonce ||
        proof.authorizationTransactionReference !== transaction.transactionReference ||
        proof.actorReference !== actual.actorReference ||
        authenticatedAt !== actual.authenticatedAt ||
        !freshTimestamp ||
        verifiedAt > authenticatedAt ||
        authenticatedAt > observedAt ||
        actual.verificationLevel !== "RecentMfa" ||
        actual.recentMfaAt !== verifiedAt ||
        (previous !== null && previous.actorReference !== actual.actorReference) ||
        typeof exchange.tokenBundle !== "string" ||
        exchange.tokenBundle.length < 1 ||
        exchange.tokenBundle.length > 8192
      )
        return denied();
      const providerObservedAt = onboarding ? parseCanonicalInstant(exchange.observedAt) : null,
        providerValidUntil = onboarding ? parseCanonicalInstant(exchange.validUntil) : null;
      if (
        providerObservedAt !== null &&
        providerValidUntil !== null &&
        (providerObservedAt < consumedAt ||
          providerObservedAt > observedAt ||
          providerValidUntil <= observedAt ||
          Date.parse(providerValidUntil) > Date.parse(providerObservedAt) + 5000)
      )
        return denied();
      const sessionReference = parseSessionReference(o.credentials.generateUuidV7()),
        selector = o.credentials.generate(),
        csrf = o.credentials.generate();
      const mfa = this.#profile.parseMfa({
        sessionReference,
        actorReference: actual.actorReference,
        method: "Totp",
        evidenceReference: proof.evidenceReference,
        authorizationTransactionReference: transaction.transactionReference,
        authenticatedAt,
        verifiedAt,
        validUntil: new Date(Date.parse(verifiedAt) + 900_000).toISOString(),
      });
      const encryptedSecrets = await o.envelopes.encrypt(
        JSON.stringify({
          profile: this.#profile.sessionProfile,
          issuer: c.issuer,
          clientId: c.clientId,
          tokenBundle: exchange.tokenBundle,
          csrf,
          mfa,
        }),
        this.#profile.sessionContext(c.environment, sessionReference, mfa.actorReference),
      );
      if (providerValidUntil !== null) {
        const at = this.#now();
        if (at < observedAt || at >= providerValidUntil) return denied();
      }
      const record =
        binding && this.#onboarding && providerObservedAt && providerValidUntil
          ? await this.#onboarding.complete({
              command: {
                sessionReference,
                actor: actual,
                policyCode: "Privileged",
                sessionSelectorHash: o.hasher.hash(selector),
                csrfSelectorHash: o.hasher.hash(csrf),
                encryptedSecrets,
                observedAt,
              },
              authorization: transaction,
              binding,
              totp: {
                method: "Totp",
                timestampPrecision: proof.timestampPrecision as "Second" | "Millisecond",
                evidenceReference: mfa.evidenceReference,
                actorReference: mfa.actorReference,
                issuer: c.issuer,
                clientId: c.clientId,
                authorizationTransactionReference: transaction.transactionReference,
                nonce,
                authenticatedAt,
                verifiedAt,
              },
              providerObservedAt,
              providerValidUntil,
            })
          : previous === null
            ? await o.store.createSession({
                sessionReference,
                actor: actual,
                policyCode: "Privileged",
                sessionSelectorHash: o.hasher.hash(selector),
                csrfSelectorHash: o.hasher.hash(csrf),
                encryptedSecrets,
                observedAt,
              })
            : await o.store.replaceAfterStepUp({
                currentSelectorHash: parseSelectorHash(previous.selectorHash),
                expectedSessionReference: parseSessionReference(previous.sessionReference),
                expectedVersion: parseSessionVersion(previous.version),
                nextSessionReference: sessionReference,
                actor: actual,
                nextSelectorHash: o.hasher.hash(selector),
                nextCsrfSelectorHash: o.hasher.hash(csrf),
                nextEncryptedSecrets: encryptedSecrets,
                observedAt,
              });
      // No post-COMMIT clock or directory read: storage performed the final authority fence.
      return Object.freeze({
        postLoginPath: parsePostLoginPath(transaction.postLoginPath, c.allowedPostLoginPaths),
        session: record.session,
        cookies: Object.freeze([
          this.#cookie("authorization", "", true),
          this.#cookie("session", selector, false),
        ]),
      });
    });
  }
  logout(input: unknown) {
    return this.#safe(async () => {
      const r = readClosedRecord(input, ["sessionCookie", "csrf"]),
        o = this.#options;
      const selectorHash = o.hasher.hash(parseRawBrowserCredential(r.sessionCookie)),
        record = await o.store.resolveSession(selectorHash);
      if (!record || record.session.actor.actorReference === null) return denied();
      const context = this.#profile.sessionContext(
        this.#configuration.environment,
        record.session.sessionReference,
        record.session.actor.actorReference,
      );
      const secrets = this.#profile.parseSecrets(
        decode(await o.envelopes.decrypt(record.encryptedSecrets, context)),
        this.#configuration,
        record.session,
      );
      if (
        !o.hasher.equals(o.hasher.hash(parseRawBrowserCredential(r.csrf)), record.csrfSelectorHash)
      )
        return denied();
      if (record.session.status === "Active")
        await o.store.revokeSession({
          selectorHash,
          expectedVersion: record.session.version,
          reason: "Logout",
          observedAt: this.#now(),
        });
      if ((await o.provider.revokeRefreshTokens(secrets.tokenBundle)) !== "confirmed")
        return Object.freeze({
          status: "Unknown" as const,
          cookies: Object.freeze([]),
          browserLogoutUrl: null,
        });
      const browserLogoutUrl = parseExactHttpsUri(o.provider.createLogoutUrl());
      const cookie = this.#cookie("session", "", true);
      return Object.freeze({
        status: "BrowserLogoutRequired" as const,
        cookies: Object.freeze([cookie]),
        browserLogoutUrl,
      });
    });
  }
}
