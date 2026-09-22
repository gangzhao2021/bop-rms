import {
  assertSessionUsable,
  createAuthenticationSession,
  sessionPolicies,
  type AuthenticationSession,
} from "../../contracts/authentication-session.js";
import {
  BrowserSessionError,
  parseRawBrowserCredential,
  parseSelectorHash,
} from "../../contracts/browser-session.js";
import {
  createIdentityActor,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  type ActorReference,
  type CanonicalInstant,
  type IdentityActor,
} from "../../contracts/identity-actor.js";
import type { BrowserCredentialHasherPort } from "../../application/ports/session-credential-ports.js";

export interface CurrentBrowserSessionTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return denied();
  return value.toISOString();
}
/** Internal Identity owner read, in the caller's transaction. currentActor must
 * resolve and fence authoritative identity facts; it must not infer Active status.
 * Never log cookie/digest/query parameters. Returns no encrypted or CSRF secrets. */
export function createPostgresCurrentBrowserSessionSource(options: {
  hasher: BrowserCredentialHasherPort;
  now(): string;
  currentActor(
    tx: CurrentBrowserSessionTransaction,
    actorReference: ActorReference,
    authenticatedAt: CanonicalInstant,
    observedAt: CanonicalInstant,
  ): Promise<IdentityActor>;
}) {
  return async (
    tx: CurrentBrowserSessionTransaction,
    cookie: unknown,
  ): Promise<AuthenticationSession> => {
    try {
      const observedAt = parseCanonicalInstant(options.now());
      const digest = parseSelectorHash(options.hasher.hash(parseRawBrowserCredential(cookie)));
      const result = await tx.query(
        "SELECT session_id,actor_id,policy_code,status,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,rotated_from_session_id,revocation_reason,revoked_at,version FROM bop_identity.authentication_session WHERE session_selector_hash=decode($1,'hex') FOR SHARE",
        [digest],
      );
      if (!result || typeof result !== "object") return denied();
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        descriptor.value.length !== 1
      )
        return denied();
      const row: Record<string, unknown> = descriptor.value[0];
      if (!row || typeof row !== "object") return denied();
      const actorReference = parseOpaqueUuidV7(
        row.actor_id,
        "ACTOR_REFERENCE_INVALID",
      ) as ActorReference;
      const authenticatedAt = parseCanonicalInstant(instant(row.authenticated_at));
      const actor = createIdentityActor(
        await options.currentActor(tx, actorReference, authenticatedAt, observedAt),
      );
      if (
        actor.actorReference !== actorReference ||
        actor.status !== "Active" ||
        actor.actorType !== "User" ||
        actor.accountKind !== "Workforce" ||
        actor.authenticationMethod !== "Oidc"
      )
        return denied();
      const policy = Object.values(sessionPolicies).find(
        (candidate) => candidate.code === row.policy_code,
      );
      if (!policy) return denied();
      const session = createAuthenticationSession({
        sessionReference: row.session_id,
        actor,
        status: row.status,
        policyCode: policy.code,
        maxActiveSessions: policy.maxActiveSessions,
        idleTimeoutMinutes: policy.idleTimeoutMinutes,
        absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
        version: row.version,
        authenticatedAt,
        createdAt: instant(row.created_at),
        lastSeenAt: instant(row.last_seen_at),
        idleExpiresAt: instant(row.idle_expires_at),
        absoluteExpiresAt: instant(row.absolute_expires_at),
        rotatedFromSessionReference: row.rotated_from_session_id,
        revocationReason: row.revocation_reason,
        revokedAt: row.revoked_at === null ? null : instant(row.revoked_at),
      });
      assertSessionUsable(session, observedAt);
      if (Date.parse(session.lastSeenAt) > Date.parse(observedAt)) return denied();
      return session;
    } catch {
      return denied();
    }
  };
}
