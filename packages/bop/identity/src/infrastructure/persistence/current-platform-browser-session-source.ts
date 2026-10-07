import {
  parseRawBrowserCredential,
  type RawBrowserCredential,
} from "../../contracts/browser-session.js";
import { createIdentityActor, parseCanonicalInstant } from "../../contracts/identity-actor.js";
import {
  assertPlatformSessionCurrent,
  parsePlatformSessionSecrets,
  platformSessionDenied as denied,
} from "../../contracts/platform-browser-session.js";
import { createPostgresPlatformBrowserSessionStore } from "./browser-session-store.js";
import type { OidcAuthorizationTransaction } from "./oidc-authorization-store.js";

type Options = Omit<
  Parameters<typeof createPostgresPlatformBrowserSessionStore>[0],
  "transactions" | "onSessionCreated"
>;
/** Identity-owned read on the caller's actual transaction. The returned packet is
 * authentication only; a Platform Permission owner must still authorize every action.
 * Encrypted secrets, token bundle and CSRF never leave this source. */
export function createPostgresCurrentPlatformBrowserSessionSource(options: Options) {
  const now = options.now,
    currentActor = options.currentActor,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals,
    envelopes = options.envelopes,
    decrypt = envelopes.decrypt;
  const environment = options.environment,
    issuer = options.issuer,
    clientId = options.clientId;
  return async (tx: OidcAuthorizationTransaction, cookie: unknown) => {
    try {
      const originalQuery = tx.query,
        observedAt = parseCanonicalInstant(now());
      const check = () => {
        const at = parseCanonicalInstant(now());
        if (
          options.environment !== environment ||
          options.issuer !== issuer ||
          options.clientId !== clientId ||
          tx.query !== originalQuery ||
          options.now !== now ||
          options.currentActor !== currentActor ||
          options.hasher !== hasher ||
          hasher.hash !== hash ||
          hasher.equals !== equals ||
          options.envelopes !== envelopes ||
          envelopes.decrypt !== decrypt ||
          at < observedAt ||
          Date.parse(at) >= Date.parse(observedAt) + 5000
        )
          return denied();
        return at;
      };
      check();
      const credential: RawBrowserCredential = parseRawBrowserCredential(cookie);
      const store = createPostgresPlatformBrowserSessionStore({
        ...options,
        transactions: { run: async (work) => work(tx) },
      });
      const record = await store.resolveSession(hash.call(hasher, credential));
      if (!record) return denied();
      const value: unknown = JSON.parse(
        await decrypt.call(
          envelopes,
          record.encryptedSecrets,
          record.encryptedSecrets.encryptionContext,
        ),
      );
      const secrets = parsePlatformSessionSecrets(value, options, record.session);
      const session = record.session;
      if (session.actor.actorReference === null) return denied();
      const actual = await currentActor(
        tx,
        session.actor.actorReference,
        session.authenticatedAt,
        check(),
      );
      const normalized = createIdentityActor({
        ...actual,
        verificationLevel: "SingleFactor",
        recentMfaAt: null,
      });
      if (JSON.stringify(normalized) !== JSON.stringify(session.actor)) return denied();
      const at = check();
      assertPlatformSessionCurrent(session, secrets.mfa, at);
      const validUntil = parseCanonicalInstant(
        new Date(
          Math.min(
            Date.parse(observedAt) + 5000,
            Date.parse(secrets.mfa.validUntil),
            Date.parse(session.idleExpiresAt),
            Date.parse(session.absoluteExpiresAt),
          ),
        ).toISOString(),
      );
      if (at >= validUntil) return denied();
      return Object.freeze({ session, recentMfa: secrets.mfa, observedAt, validUntil });
    } catch {
      return denied();
    }
  };
}
