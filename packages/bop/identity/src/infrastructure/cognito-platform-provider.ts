import { BrowserSessionError } from "../contracts/browser-session.js";
import {
  createIdentityActor,
  parseOpaqueUuidV7,
  readClosedRecord,
  type IdentityActor,
} from "../contracts/identity-actor.js";
import {
  parsePlatformActor,
  type PlatformOidcProviderPort,
} from "../contracts/platform-browser-session.js";
import {
  createCognitoProviderProtocol,
  type CognitoProviderConfiguration,
} from "./cognito-provider-protocol.js";
import type { CognitoPoolMfaPolicy } from "./cognito-pool-mfa-policy.js";
export interface CognitoPlatformProviderOptions {
  readonly configuration: CognitoProviderConfiguration;
  readonly clock: { now(): string };
  readonly nextEvidenceReference: () => string;
  readonly resolveVerifiedSubject: (input: {
    readonly issuer: string;
    readonly clientId: string;
    readonly subject: string;
    readonly authenticatedAt: string;
    readonly observedAt: string;
  }) => Promise<IdentityActor>;
  /**
   * WP-2423 DEC-COGNITO-STORE-STAFF: the pool's MFA check. With it, real Cognito tokens without
   * `acr`/`amr` are accepted once the pool is verified to require the authenticator app.
   */
  readonly poolPolicy?: Pick<CognitoPoolMfaPolicy, "assertRequiredTotp">;
  readonly http?: typeof globalThis.fetch;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
/** Fixed Platform owner binding over the shared real Cognito wire protocol. */
export function createCognitoPlatformProvider(
  options: CognitoPlatformProviderOptions,
): PlatformOidcProviderPort {
  try {
    const o = readClosedRecord(options, [
        "configuration",
        "clock",
        "nextEvidenceReference",
        "resolveVerifiedSubject",
        ...(Object.hasOwn(options, "poolPolicy") ? ["poolPolicy"] : []),
        ...(Object.hasOwn(options, "http") ? ["http"] : []),
      ]),
      resolve = o.resolveVerifiedSubject,
      next = o.nextEvidenceReference;
    if (typeof resolve !== "function" || typeof next !== "function") return denied();
    const protocol = createCognitoProviderProtocol({
      configuration: options.configuration,
      clock: options.clock,
      accountKind: "Platform",
      ...(options.poolPolicy === undefined ? {} : { poolPolicy: options.poolPolicy }),
      ...(options.http === undefined ? {} : { http: options.http }),
    });
    return Object.freeze({
      createAuthorizationUrl: protocol.createAuthorizationUrl,
      revokeRefreshTokens: protocol.revokeRefreshTokens,
      createLogoutUrl: protocol.createLogoutUrl,
      async exchangeCode(value: Parameters<PlatformOidcProviderPort["exchangeCode"]>[0]) {
        try {
          const verified = await protocol.exchangeVerifiedCode(value);
          const directoryActor = parsePlatformActor(
            await resolve(
              Object.freeze({
                issuer: verified.issuer,
                clientId: verified.clientId,
                subject: verified.subject,
                authenticatedAt: verified.authenticatedAt,
                observedAt: verified.observedAt,
              }),
            ),
          );
          verified.assertCurrent();
          if (
            directoryActor.authenticatedAt !== verified.authenticatedAt ||
            directoryActor.verificationLevel !== "SingleFactor" ||
            directoryActor.recentMfaAt !== null
          )
            return denied();
          const actor = createIdentityActor({
            ...directoryActor,
            verificationLevel: "RecentMfa",
            recentMfaAt: verified.authenticatedAt,
          });
          if (actor.actorReference === null) return denied();
          const evidenceReference = parseOpaqueUuidV7(next(), "ACTOR_REFERENCE_INVALID");
          verified.assertCurrent();
          return Object.freeze({
            actor,
            tokenBundle: verified.tokenBundle,
            totp: Object.freeze({
              method: "Totp" as const,
              timestampPrecision: "Second" as const,
              evidenceReference,
              actorReference: actor.actorReference,
              issuer: verified.issuer,
              clientId: verified.clientId,
              authorizationTransactionReference: verified.authorizationTransactionReference,
              nonce: verified.nonce,
              authenticatedAt: verified.authenticatedAt,
              verifiedAt: verified.authenticatedAt,
            }),
          });
        } catch {
          return denied();
        }
      },
    });
  } catch {
    return denied();
  }
}
