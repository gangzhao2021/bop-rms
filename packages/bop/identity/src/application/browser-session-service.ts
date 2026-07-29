import {
  assertSessionUsable,
  parseSessionReference,
  sessionPolicies,
  type AuthenticationSession,
  type SessionPolicyCode,
} from "../contracts/authentication-session.js";
import {
  authorizationCookie,
  BrowserSessionError,
  createAuthorizationTransaction,
  merchantSessionCookie,
  parseAuthorizationTransactionReference,
  parseExactHttpsUri,
  parsePostLoginPath,
  parseRawBrowserCredential,
  type BrowserCookieDescriptor,
  type BrowserSessionConfiguration,
  type RawBrowserCredential,
} from "../contracts/browser-session.js";
import { createIdentityActor, parseCanonicalInstant } from "../contracts/identity-actor.js";
import type { BrowserSessionStorePort } from "./ports/browser-session-store-port.js";
import type { OidcProviderPort } from "./ports/oidc-provider-port.js";
import type {
  BrowserCredentialGeneratorPort,
  BrowserCredentialHasherPort,
  PkcePort,
  SessionEnvelopeCryptoPort,
} from "./ports/session-credential-ports.js";

export interface BrowserSessionServiceOptions {
  readonly configuration: BrowserSessionConfiguration;
  readonly store: BrowserSessionStorePort;
  readonly provider: OidcProviderPort;
  readonly credentials: BrowserCredentialGeneratorPort;
  readonly hasher: BrowserCredentialHasherPort;
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly pkce: PkcePort;
  readonly now?: () => unknown;
}

export interface BrowserCookieMutation {
  readonly descriptor: BrowserCookieDescriptor;
  readonly value: RawBrowserCredential | "";
  readonly clear: boolean;
}

const encodeSecrets = (value: Readonly<Record<string, string>>): string => JSON.stringify(value);

function decodeSecrets<const T extends readonly string[]>(
  value: string,
  keys: T,
): Readonly<Record<T[number], string>> {
  try {
    const decoded: unknown = JSON.parse(value);
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      Reflect.ownKeys(decoded).some((key) => typeof key !== "string" || !keys.includes(key)) ||
      Reflect.ownKeys(decoded).length !== keys.length
    ) {
      throw new Error("invalid");
    }
    const record = decoded as Record<string, unknown>;
    if (keys.some((key) => typeof record[key] !== "string")) throw new Error("invalid");
    return record as Record<T[number], string>;
  } catch {
    throw new BrowserSessionError("BROWSER_SESSION_DENIED");
  }
}

export class BrowserSessionService {
  readonly #configuration: BrowserSessionConfiguration;
  readonly #store: BrowserSessionStorePort;
  readonly #provider: OidcProviderPort;
  readonly #credentials: BrowserCredentialGeneratorPort;
  readonly #hasher: BrowserCredentialHasherPort;
  readonly #envelopes: SessionEnvelopeCryptoPort;
  readonly #pkce: PkcePort;
  readonly #now: () => unknown;

  constructor(options: BrowserSessionServiceOptions) {
    if (
      !/^[A-Za-z0-9._~-]{1,255}$/u.test(options.configuration.clientId) ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(options.configuration.environment) ||
      options.configuration.allowedPostLoginPaths.length === 0 ||
      options.configuration.allowedPostLoginPaths.some(
        (path) => parsePostLoginPath(path, options.configuration.allowedPostLoginPaths) !== path,
      )
    ) {
      throw new BrowserSessionError("BROWSER_SESSION_INPUT_INVALID");
    }
    this.#configuration = Object.freeze({
      ...options.configuration,
      issuer: parseExactHttpsUri(options.configuration.issuer),
      redirectUri: parseExactHttpsUri(options.configuration.redirectUri),
      allowedPostLoginPaths: Object.freeze([...options.configuration.allowedPostLoginPaths]),
    });
    this.#store = options.store;
    this.#provider = options.provider;
    this.#credentials = options.credentials;
    this.#hasher = options.hasher;
    this.#envelopes = options.envelopes;
    this.#pkce = options.pkce;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  #observedAt() {
    return parseCanonicalInstant(this.#now());
  }

  async start(postLoginPathInput: unknown): Promise<{
    readonly authorizationUrl: string;
    readonly cookie: BrowserCookieMutation;
  }> {
    const observedAt = this.#observedAt();
    const postLoginPath = parsePostLoginPath(
      postLoginPathInput,
      this.#configuration.allowedPostLoginPaths,
    );
    const authCookieValue = this.#credentials.generate();
    const state = this.#credentials.generate();
    const nonce = this.#credentials.generate();
    const codeVerifier = this.#credentials.generate();
    const transactionReference = parseAuthorizationTransactionReference(
      this.#credentials.generateUuidV7(),
    );
    const encryptionContext = `${this.#configuration.environment}:oidc:${transactionReference}`;
    const encryptedSecrets = await this.#envelopes.encrypt(
      encodeSecrets({ nonce, codeVerifier }),
      encryptionContext,
    );
    await this.#store.createAuthorizationTransaction(
      createAuthorizationTransaction({
        transactionReference,
        stateSelectorHash: this.#hasher.hash(state),
        authCookieSelectorHash: this.#hasher.hash(authCookieValue),
        encryptedSecrets,
        redirectUri: this.#configuration.redirectUri,
        postLoginPath,
        expiresAt: new Date(Date.parse(observedAt) + 600_000).toISOString() as never,
        consumedAt: null,
        version: 1 as never,
      }),
    );
    const authorizationUrl = parseExactHttpsUri(
      await this.#provider.createAuthorizationUrl({
        issuer: this.#configuration.issuer,
        clientId: this.#configuration.clientId,
        redirectUri: this.#configuration.redirectUri,
        state,
        nonce,
        codeChallenge: this.#pkce.challenge(codeVerifier),
        codeChallengeMethod: "S256",
      }),
    );
    return Object.freeze({
      authorizationUrl,
      cookie: Object.freeze({
        descriptor: authorizationCookie,
        value: authCookieValue,
        clear: false,
      }),
    });
  }

  async callback(input: {
    readonly code: unknown;
    readonly state: unknown;
    readonly authCookie: unknown;
    readonly policyCode?: SessionPolicyCode;
  }): Promise<{
    readonly postLoginPath: string;
    readonly session: AuthenticationSession;
    readonly cookies: readonly BrowserCookieMutation[];
  }> {
    try {
      const observedAt = this.#observedAt();
      const code = parseRawBrowserCredential(input.code);
      const state = parseRawBrowserCredential(input.state);
      const authCookie = parseRawBrowserCredential(input.authCookie);
      const transaction = await this.#store.consumeAuthorizationTransaction({
        stateSelectorHash: this.#hasher.hash(state),
        authCookieSelectorHash: this.#hasher.hash(authCookie),
        consumedAt: observedAt,
      });
      if (
        transaction === null ||
        transaction.consumedAt === null ||
        Date.parse(observedAt) >= Date.parse(transaction.expiresAt) ||
        transaction.redirectUri !== this.#configuration.redirectUri
      ) {
        throw new BrowserSessionError("BROWSER_SESSION_DENIED");
      }
      const postLoginPath = parsePostLoginPath(
        transaction.postLoginPath,
        this.#configuration.allowedPostLoginPaths,
      );
      const context = `${this.#configuration.environment}:oidc:${transaction.transactionReference}`;
      const secrets = decodeSecrets(
        await this.#envelopes.decrypt(transaction.encryptedSecrets, context),
        ["nonce", "codeVerifier"],
      );
      const exchange = await this.#provider.exchangeCode({
        issuer: this.#configuration.issuer,
        clientId: this.#configuration.clientId,
        redirectUri: transaction.redirectUri,
        code,
        nonce: secrets.nonce,
        codeVerifier: secrets.codeVerifier,
      });
      if (
        typeof exchange.tokenBundle !== "string" ||
        exchange.tokenBundle.length < 1 ||
        exchange.tokenBundle.length > 16_384
      ) {
        throw new BrowserSessionError("BROWSER_SESSION_DENIED");
      }
      const actor = createIdentityActor(exchange.actor);
      if (actor.actorReference === null) throw new BrowserSessionError("BROWSER_SESSION_DENIED");
      const selector = this.#credentials.generate();
      const csrf = this.#credentials.generate();
      const sessionReference = parseSessionReference(this.#credentials.generateUuidV7());
      const sessionContext = `${this.#configuration.environment}:session:${sessionReference}:${actor.actorReference}`;
      const encryptedSecrets = await this.#envelopes.encrypt(
        encodeSecrets({ tokenBundle: exchange.tokenBundle, csrf }),
        sessionContext,
      );
      const record = await this.#store.createSession({
        sessionReference,
        actor,
        policyCode: input.policyCode ?? "WorkforceStandard",
        sessionSelectorHash: this.#hasher.hash(selector),
        csrfSelectorHash: this.#hasher.hash(csrf),
        encryptedSecrets,
        observedAt,
      });
      return Object.freeze({
        postLoginPath,
        session: record.session,
        cookies: Object.freeze([
          Object.freeze({ descriptor: authorizationCookie, value: "", clear: true }),
          Object.freeze({ descriptor: merchantSessionCookie, value: selector, clear: false }),
        ]),
      });
    } catch {
      throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    }
  }

  async bootstrap(sessionCookieInput: unknown): Promise<{
    readonly session: AuthenticationSession;
    readonly csrf: RawBrowserCredential;
  }> {
    const observedAt = this.#observedAt();
    const sessionCookie = parseRawBrowserCredential(sessionCookieInput);
    const record = await this.#store.resolveSession(this.#hasher.hash(sessionCookie));
    if (record === null) throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    assertSessionUsable(record.session, observedAt);
    if (record.session.actor.actorReference === null) {
      throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    }
    const context = `${this.#configuration.environment}:session:${record.session.sessionReference}:${record.session.actor.actorReference}`;
    const secrets = decodeSecrets(await this.#envelopes.decrypt(record.encryptedSecrets, context), [
      "tokenBundle",
      "csrf",
    ]);
    const csrf = parseRawBrowserCredential(secrets.csrf);
    if (!this.#hasher.equals(this.#hasher.hash(csrf), record.csrfSelectorHash)) {
      throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    }
    return Object.freeze({ session: record.session, csrf });
  }

  async authorize(input: {
    readonly sessionCookie: unknown;
    readonly csrf: unknown;
  }): Promise<AuthenticationSession> {
    const bootstrap = await this.bootstrap(input.sessionCookie);
    const csrf = parseRawBrowserCredential(input.csrf);
    const supplied = this.#hasher.hash(csrf);
    const record = await this.#store.resolveSession(
      this.#hasher.hash(parseRawBrowserCredential(input.sessionCookie)),
    );
    if (record === null || !this.#hasher.equals(supplied, record.csrfSelectorHash)) {
      throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    }
    assertSessionUsable(record.session, this.#observedAt());
    if (record.session.sessionReference !== bootstrap.session.sessionReference) {
      throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    }
    return record.session;
  }

  async rotate(
    sessionCookieInput: unknown,
    reason:
      "MfaCompletion" | "PrivilegeElevation" | "StoreContextElevation" | "Recovery" | "RiskChange",
  ): Promise<{
    readonly session: AuthenticationSession;
    readonly cookie: BrowserCookieMutation;
  }> {
    const observedAt = this.#observedAt();
    const currentSelector = parseRawBrowserCredential(sessionCookieInput);
    const currentSelectorHash = this.#hasher.hash(currentSelector);
    const current = await this.#store.resolveSession(currentSelectorHash);
    if (current === null || current.session.actor.actorReference === null) {
      throw new BrowserSessionError("BROWSER_SESSION_DENIED");
    }
    assertSessionUsable(current.session, observedAt);
    const currentContext = `${this.#configuration.environment}:session:${current.session.sessionReference}:${current.session.actor.actorReference}`;
    const secrets = decodeSecrets(
      await this.#envelopes.decrypt(current.encryptedSecrets, currentContext),
      ["tokenBundle", "csrf"],
    );
    const nextSelector = this.#credentials.generate();
    const nextCsrf = this.#credentials.generate();
    const nextSessionReference = parseSessionReference(this.#credentials.generateUuidV7());
    const nextContext = `${this.#configuration.environment}:session:${nextSessionReference}:${current.session.actor.actorReference}`;
    const nextEncryptedSecrets = await this.#envelopes.encrypt(
      encodeSecrets({ tokenBundle: secrets.tokenBundle, csrf: nextCsrf }),
      nextContext,
    );
    const next = await this.#store.rotateSession({
      currentSelectorHash,
      expectedVersion: current.session.version,
      nextSessionReference,
      nextSelectorHash: this.#hasher.hash(nextSelector),
      nextCsrfSelectorHash: this.#hasher.hash(nextCsrf),
      nextEncryptedSecrets,
      reason,
      observedAt,
    });
    return Object.freeze({
      session: next.session,
      cookie: Object.freeze({
        descriptor: merchantSessionCookie,
        value: nextSelector,
        clear: false,
      }),
    });
  }

  async logout(sessionCookieInput: unknown): Promise<BrowserCookieMutation> {
    try {
      const observedAt = this.#observedAt();
      const selector = parseRawBrowserCredential(sessionCookieInput);
      const selectorHash = this.#hasher.hash(selector);
      const record = await this.#store.resolveSession(selectorHash);
      if (record !== null) {
        await this.#store.revokeSession({
          selectorHash,
          expectedVersion: record.session.version,
          reason: "Logout",
          observedAt,
        });
        if (record.session.actor.actorReference !== null) {
          const context = `${this.#configuration.environment}:session:${record.session.sessionReference}:${record.session.actor.actorReference}`;
          const secrets = decodeSecrets(
            await this.#envelopes.decrypt(record.encryptedSecrets, context),
            ["tokenBundle", "csrf"],
          );
          await this.#provider.revokeOrLogout(secrets.tokenBundle);
        }
      }
    } catch {
      // Local unknown/revoked state is intentionally indistinguishable and logout stays idempotent.
    }
    return Object.freeze({ descriptor: merchantSessionCookie, value: "", clear: true });
  }

  policy(code: SessionPolicyCode) {
    return sessionPolicies[code];
  }
}
