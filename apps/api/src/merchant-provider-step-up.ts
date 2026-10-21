import {
  BrowserSessionError,
  createAuthorizationTransaction,
  createPostgresOidcAuthorizationStore,
  createPostgresWorkforceReauthenticationStepUpStore,
  parseAuthorizationTransactionReference,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  parseRawBrowserCredential,
  parseSessionVersion,
  readClosedRecord,
  type CognitoStoreVerifiedSubject,
  type OidcAuthorizationRequest,
  type OidcCodeExchangeRequest,
} from "@bop/identity";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { createMerchantStepUpStatus, merchantStepUpPurposeCode } from "./merchant-mfa-step-up.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff-contract.js";

/**
 * WP-2423 DEC-COGNITO-STORE-STAFF (DEC-REFUND-ESCALATION-PILOT decision 2, production method):
 * the signed-in staff member re-verifies by signing in to Cognito again (password and
 * authenticator, `prompt=login`) in a separate window; the fresh authentication is recorded as a
 * verified step-up for their current session and Store in the same record the authenticator-code
 * check writes, so refund approvals and PIN elevation read one recency. The sign-in must name the
 * session's own person; it never changes who is signed in and keeps no Provider token.
 */
export const stepUpCookieName = "__Host-bop-step-up";
export const stepUpCompletePath = "/app/identity/step-up-complete";
/**
 * `unavailable`: the sign-in could not be started because the identity provider's pool check
 * (MFA required, authenticator app only) did not pass or could not be read; nothing is recorded.
 */
export type ProviderStepUpResult = "verified" | "cancelled" | "failed" | "unavailable";
const stepUpWindowMs = 600_000;
interface StepUpProvider {
  readonly redirectUri: string;
  createAuthorizationUrl(request: OidcAuthorizationRequest): Promise<string>;
  verify(request: OidcCodeExchangeRequest): Promise<CognitoStoreVerifiedSubject>;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
const returnPathPattern = /^\/(?!\/)[A-Za-z0-9/_?=&.%-]{0,300}$/u;
/** Where to go back after the step-up: a same-origin app or staff screen path, else Home. */
export function parseStepUpReturnPath(value: unknown): string {
  return typeof value === "string" &&
    returnPathPattern.test(value) &&
    !value.includes("\\") &&
    (value === "/app" ||
      value.startsWith("/app/") ||
      value.startsWith("/app?") ||
      value.startsWith("/operations/"))
    ? value
    : "/app";
}

export function createMerchantProviderStepUp(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "bootstrap">;
  readonly provider: StepUpProvider;
  readonly issuer: string;
  readonly clientId: string;
  readonly environment: string;
  readonly boundActor: (verified: CognitoStoreVerifiedSubject) => Promise<string>;
  readonly newReference: () => string;
}) {
  const persistence = options.persistence,
    identity = persistence.identity,
    environment = options.environment;
  const store = createPostgresOidcAuthorizationStore({
    transactions: persistence.transactions as Parameters<
      typeof createPostgresOidcAuthorizationStore
    >[0]["transactions"],
    environment,
    redirectUri: options.provider.redirectUri,
    allowedPostLoginPaths: [stepUpCompletePath],
  });
  const resolve = createMerchantStoreScope(persistence);
  const record = createPostgresWorkforceReauthenticationStepUpStore;
  const now = () => parseCanonicalInstant(persistence.now());

  /** Starts a re-authentication for the current session; the cookie binds the window. */
  async function start(input: {
    readonly sessionCookie: unknown;
    readonly purpose: unknown;
    readonly returnTo: unknown;
  }): Promise<{ readonly authorizationUrl: string; readonly cookie: string }> {
    const purposeCode = merchantStepUpPurposeCode(input.purpose);
    if (purposeCode === null) return denied();
    const current = await options.authentication.bootstrap(input.sessionCookie);
    const session = current.session;
    if (session.actor.actorReference === null) return denied();
    const startedAt = now();
    const generate = () => identity.credentials.generate();
    const cookie = generate(),
      state = generate(),
      nonce = generate(),
      codeVerifier = generate();
    const transactionReference = parseAuthorizationTransactionReference(
      identity.credentials.generateUuidV7(),
    );
    // The provider may refuse to start (its pool check says sign-in is not safe now): nothing is
    // written and the window says so.
    const authorizationUrl = await options.provider.createAuthorizationUrl({
      issuer: options.issuer,
      clientId: options.clientId,
      redirectUri: options.provider.redirectUri,
      state,
      nonce,
      codeChallenge: identity.pkce.challenge(codeVerifier),
      codeChallengeMethod: "S256",
    });
    const encryptedSecrets = await identity.envelopes.encrypt(
      JSON.stringify({
        profile: "MerchantProviderStepUpV1",
        nonce,
        codeVerifier,
        sessionReference: session.sessionReference,
        actorReference: session.actor.actorReference,
        purposeCode,
        returnTo: parseStepUpReturnPath(input.returnTo),
      }),
      `${environment}:oidc:${transactionReference}`,
    );
    await store.createAuthorizationTransaction(
      createAuthorizationTransaction({
        transactionReference,
        stateSelectorHash: identity.hasher.hash(state),
        authCookieSelectorHash: identity.hasher.hash(cookie),
        encryptedSecrets,
        redirectUri: options.provider.redirectUri,
        postLoginPath: stepUpCompletePath,
        expiresAt: parseCanonicalInstant(
          new Date(Date.parse(startedAt) + stepUpWindowMs).toISOString(),
        ),
        consumedAt: null,
        version: parseSessionVersion(1),
      }),
    );
    return Object.freeze({ authorizationUrl, cookie });
  }

  /**
   * The Provider's answer. `failed` covers anything not proven (expired window, another person,
   * a replayed sign-in, an ended session); only `verified` writes a step-up.
   */
  async function callback(input: {
    readonly code: unknown;
    readonly state: unknown;
    readonly error: unknown;
    readonly stepUpCookie: unknown;
    readonly sessionCookie: unknown;
  }): Promise<{ readonly result: ProviderStepUpResult; readonly returnTo: string }> {
    let returnTo = "/app";
    try {
      const consumedAt = now();
      const transaction = await store.consumeAuthorizationTransaction({
        stateSelectorHash: identity.hasher.hash(parseRawBrowserCredential(input.state)),
        authCookieSelectorHash: identity.hasher.hash(parseRawBrowserCredential(input.stepUpCookie)),
        consumedAt,
      });
      if (
        transaction === null ||
        transaction.consumedAt === null ||
        consumedAt >= transaction.expiresAt ||
        transaction.redirectUri !== options.provider.redirectUri
      )
        return { result: "failed", returnTo };
      const secrets = readClosedRecord(
        JSON.parse(
          await identity.envelopes.decrypt(
            transaction.encryptedSecrets,
            `${environment}:oidc:${transaction.transactionReference}`,
          ),
        ),
        [
          "profile",
          "nonce",
          "codeVerifier",
          "sessionReference",
          "actorReference",
          "purposeCode",
          "returnTo",
        ],
      );
      if (secrets.profile !== "MerchantProviderStepUpV1") return { result: "failed", returnTo };
      returnTo = parseStepUpReturnPath(secrets.returnTo);
      // The person closed or cancelled the sign-in: nothing is recorded.
      if (input.code === undefined && input.error !== undefined)
        return { result: "cancelled", returnTo };
      const verified = await options.provider.verify({
        issuer: options.issuer,
        clientId: options.clientId,
        redirectUri: options.provider.redirectUri,
        code: String(input.code),
        nonce: parseRawBrowserCredential(secrets.nonce),
        codeVerifier: parseRawBrowserCredential(secrets.codeVerifier),
        // `start` made the transaction expire ten minutes after it began.
        authorizationStartedAt: new Date(
          Date.parse(transaction.expiresAt) - stepUpWindowMs,
        ).toISOString(),
      });
      const actorReference = await options.boundActor(verified);
      const current = await options.authentication.bootstrap(input.sessionCookie);
      const sessionReference = String(current.session.sessionReference);
      if (
        actorReference !== secrets.actorReference ||
        current.session.actor.actorReference !== actorReference ||
        sessionReference !== secrets.sessionReference
      )
        return { result: "failed", returnTo };
      const stepUpReference = String(
        parseOpaqueUuidV7(options.newReference(), "ACTOR_REFERENCE_INVALID"),
      );
      const auditReference = String(
        parseOpaqueUuidV7(options.newReference(), "ACTOR_REFERENCE_INVALID"),
      );
      await persistence.transactions.run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              const resolved = await resolve(
                tx,
                input.sessionCookie,
                "merchant.access",
                sessionReference,
              );
              if ((await resolved.allowed()) !== true) return denied();
              return resolved;
            },
            recheck: async (scope) => (await scope.allowed()) === true,
            denied,
          },
          async (authority) => {
            const scope = authority.scope;
            const binding = {
              brandReference: String(scope.context.brand.brandReference),
              storeReference: String(scope.store.storeReference),
              actorReference: String(scope.actorReference),
              sessionReference: String(scope.sessionReference),
            };
            if (binding.actorReference !== actorReference) return denied();
            return record({
              authorize: async (ownerTransaction, query) =>
                query.brandReference === binding.brandReference &&
                query.storeReference === binding.storeReference &&
                query.actorReference === binding.actorReference &&
                query.sessionReference === binding.sessionReference &&
                (await authority.guard(ownerTransaction)),
              retentionPolicyCode: "SECURITY_AUDIT",
              retentionPolicyVersion: 1,
            })(tx, {
              ...binding,
              stepUpReference,
              auditReference,
              purposeCode: secrets.purposeCode,
              authenticatedAt: verified.authenticatedAt,
            });
          },
        ),
      );
      return { result: "verified", returnTo };
    } catch {
      return { result: "failed", returnTo };
    }
  }

  return Object.freeze({
    start,
    callback,
    status: createMerchantStepUpStatus(persistence),
  });
}
