import { Buffer } from "node:buffer";
import {
  assertSessionUsable,
  createAuthenticationSession,
  sessionPolicies,
  type AuthenticationSession,
} from "../../contracts/authentication-session.js";
import {
  BrowserSessionError,
  createBrowserSessionRecord,
  type BrowserSessionRecord,
  parseRawBrowserCredential,
  parseSelectorHash,
  parseExactHttpsUri,
  type EncryptedSecretEnvelope,
} from "../../contracts/browser-session.js";
import {
  createIdentityActor,
  readClosedRecord,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  type ActorReference,
  type CanonicalInstant,
  type IdentityActor,
} from "../../contracts/identity-actor.js";
import {
  assertWorkforceSessionCurrent,
  parseWorkforceSessionSecrets,
} from "../../contracts/workforce-browser-session.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../../application/ports/session-credential-ports.js";

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
interface Options {
  hasher: BrowserCredentialHasherPort;
  now(): string;
  currentActor(
    tx: CurrentBrowserSessionTransaction,
    actorReference: ActorReference,
    authenticatedAt: CanonicalInstant,
    observedAt: CanonicalInstant,
  ): Promise<IdentityActor>;
}
interface WorkforceOptions extends Options {
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly configuration: {
    readonly environment: string;
    readonly issuer: string;
    readonly clientId: string;
  };
}
export function createPostgresCurrentBrowserSessionSource(options: Options) {
  return source(options);
}
export function createPostgresCurrentWorkforceBrowserSessionSource(options: WorkforceOptions) {
  return source(options, options);
}
/** The supplied record is only a lookup/binding candidate. Persisted Session,
 * current identity and encrypted same-Session proof remain authoritative. */
export function createPostgresCurrentWorkforceBrowserSessionRecordSource(
  options: WorkforceOptions,
) {
  const read = source(options, options, true);
  return (
    tx: CurrentBrowserSessionTransaction,
    record: BrowserSessionRecord,
  ): Promise<AuthenticationSession> => read(tx, record);
}
function recordCandidate(value: unknown): BrowserSessionRecord {
  const r = readClosedRecord(value, [
    "session",
    "sessionSelectorHash",
    "csrfSelectorHash",
    "encryptedSecrets",
  ]);
  const session = readClosedRecord(r.session, [
    "sessionReference",
    "actor",
    "status",
    "policy",
    "version",
    "authenticatedAt",
    "createdAt",
    "lastSeenAt",
    "idleExpiresAt",
    "absoluteExpiresAt",
    "rotatedFromSessionReference",
    "revocationReason",
    "revokedAt",
  ]);
  readClosedRecord(session.policy, [
    "code",
    "maxActiveSessions",
    "idleTimeoutMinutes",
    "absoluteTimeoutMinutes",
  ]);
  const envelope = readClosedRecord(r.encryptedSecrets, [
    "algorithm",
    "keyReference",
    "ciphertext",
    "encryptionContext",
  ]);
  if (
    (envelope.algorithm !== "SYNTHETIC_AES_256_GCM" && envelope.algorithm !== "KMS_AES_256_GCM") ||
    typeof envelope.keyReference !== "string" ||
    typeof envelope.ciphertext !== "string" ||
    typeof envelope.encryptionContext !== "string"
  )
    return denied();
  return createBrowserSessionRecord({
    session,
    sessionSelectorHash: r.sessionSelectorHash,
    csrfSelectorHash: r.csrfSelectorHash,
    encryptedSecrets: {
      algorithm: envelope.algorithm,
      keyReference: envelope.keyReference,
      ciphertext: envelope.ciphertext,
      encryptionContext: envelope.encryptionContext,
    },
  });
}
function source(options: Options, workforce?: WorkforceOptions, byRecord = false) {
  const now = options.now,
    currentActor = options.currentActor,
    hasher = options.hasher,
    hash = hasher.hash,
    equals = hasher.equals;
  const envelopes = workforce?.envelopes,
    decrypt = envelopes?.decrypt;
  const configuration = workforce ? Object.freeze({ ...workforce.configuration }) : null;
  if (
    configuration &&
    (!/^[a-z][a-z0-9-]{0,63}$/u.test(configuration.environment) ||
      !/^[A-Za-z0-9._~-]{1,255}$/u.test(configuration.clientId) ||
      parseExactHttpsUri(configuration.issuer) !== configuration.issuer)
  )
    return denied();
  return async (
    tx: CurrentBrowserSessionTransaction,
    cookie: unknown,
  ): Promise<AuthenticationSession> => {
    try {
      const observedAt = parseCanonicalInstant(now.call(options));
      const query = tx.query;
      let latest = observedAt;
      const check = () => {
        if (!workforce) return;
        const at = parseCanonicalInstant(now.call(options));
        if (
          tx.query !== query ||
          options.now !== now ||
          options.currentActor !== currentActor ||
          options.hasher !== hasher ||
          hasher.hash !== hash ||
          hasher.equals !== equals ||
          workforce.envelopes !== envelopes ||
          envelopes?.decrypt !== decrypt ||
          JSON.stringify(workforce.configuration) !== JSON.stringify(configuration) ||
          at < latest ||
          Date.parse(at) >= Date.parse(observedAt) + 5000
        )
          return denied();
        latest = at;
      };
      check();
      const expected = byRecord ? recordCandidate(cookie) : null;
      const digest = expected
        ? expected.sessionSelectorHash
        : parseSelectorHash(hash.call(hasher, parseRawBrowserCredential(cookie)));
      check();
      const result = await (workforce ? query : tx.query).call(
        tx,
        "SELECT session_id,actor_id,policy_code,status,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,rotated_from_session_id,revocation_reason,revoked_at,version" +
          (workforce
            ? ",cipher_algorithm,key_reference,encrypted_secret,encryption_context,csrf_selector_hash"
            : "") +
          " FROM bop_identity.authentication_session WHERE session_selector_hash=decode($1,'hex') " +
          (workforce
            ? "AND authenticated_at=date_trunc('milliseconds',authenticated_at) AND created_at=date_trunc('milliseconds',created_at) AND last_seen_at=date_trunc('milliseconds',last_seen_at) AND idle_expires_at=date_trunc('milliseconds',idle_expires_at) AND absolute_expires_at=date_trunc('milliseconds',absolute_expires_at) AND (revoked_at IS NULL OR revoked_at=date_trunc('milliseconds',revoked_at)) "
            : "") +
          "FOR SHARE",
        [digest],
      );
      check();
      if (!result || typeof result !== "object") return denied();
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        descriptor.value.length !== 1
      )
        return denied();
      const index = Object.getOwnPropertyDescriptor(descriptor.value, "0");
      if (workforce && (!index || !("value" in index))) return denied();
      const originalRow: unknown = workforce ? index?.value : descriptor.value[0];
      if (!originalRow || typeof originalRow !== "object") return denied();
      let row: Record<string, unknown>;
      if (workforce) {
        row = {};
        for (const key of Reflect.ownKeys(originalRow)) {
          const field = Object.getOwnPropertyDescriptor(originalRow, key);
          if (typeof key !== "string" || !field || !("value" in field)) return denied();
          const value: unknown = field.value;
          row[key] =
            value instanceof Date
              ? new Date(value.getTime())
              : value instanceof Uint8Array
                ? Uint8Array.from(value)
                : value;
        }
        Object.freeze(row);
      } else row = originalRow as Record<string, unknown>;
      const actorReference = parseOpaqueUuidV7(
        row.actor_id,
        "ACTOR_REFERENCE_INVALID",
      ) as ActorReference;
      const authenticatedAt = parseCanonicalInstant(instant(row.authenticated_at));
      const actor = createIdentityActor(
        await currentActor.call(options, tx, actorReference, authenticatedAt, observedAt),
      );
      check();
      if (
        actor.actorReference !== actorReference ||
        actor.status !== "Active" ||
        actor.actorType !== "User" ||
        actor.accountKind !== "Workforce" ||
        actor.authenticationMethod !== "Oidc" ||
        (workforce &&
          (actor.authenticatedAt !== authenticatedAt ||
            actor.verificationLevel !== "SingleFactor" ||
            actor.recentMfaAt !== null))
      )
        return denied();
      const policy = Object.values(sessionPolicies).find(
        (candidate) => candidate.code === row.policy_code,
      );
      if (!policy || (workforce && policy.code !== "Privileged")) return denied();
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
      if (workforce) {
        if (
          !configuration ||
          !envelopes ||
          !decrypt ||
          (row.cipher_algorithm !== "SYNTHETIC_AES_256_GCM" &&
            row.cipher_algorithm !== "KMS_AES_256_GCM") ||
          typeof row.key_reference !== "string" ||
          !/^[\x21-\x7e]{1,255}$/u.test(row.key_reference) ||
          row.encryption_context !==
            `${configuration.environment}:session:${session.sessionReference}:${actorReference}` ||
          !(row.encrypted_secret instanceof Uint8Array) ||
          row.encrypted_secret.byteLength < 29 ||
          row.encrypted_secret.byteLength > 16384 ||
          !(row.csrf_selector_hash instanceof Uint8Array) ||
          row.csrf_selector_hash.byteLength !== 32
        )
          return denied();
        const envelope: EncryptedSecretEnvelope = Object.freeze({
          algorithm: row.cipher_algorithm,
          keyReference: row.key_reference,
          ciphertext: Buffer.from(row.encrypted_secret).toString("base64url"),
          encryptionContext: row.encryption_context,
        });
        if (
          expected &&
          (expected.session.sessionReference !== session.sessionReference ||
            expected.session.version !== session.version ||
            expected.session.actor.actorReference !== actorReference ||
            expected.session.actor.actorType !== actor.actorType ||
            expected.session.actor.accountKind !== actor.accountKind ||
            expected.session.actor.authenticationMethod !== actor.authenticationMethod ||
            expected.session.actor.status !== actor.status ||
            expected.session.actor.authenticatedAt !== authenticatedAt ||
            expected.session.authenticatedAt !== authenticatedAt ||
            expected.session.createdAt !== session.createdAt ||
            expected.session.status !== session.status ||
            expected.session.policy.code !== session.policy.code ||
            expected.session.rotatedFromSessionReference !== session.rotatedFromSessionReference ||
            expected.csrfSelectorHash !==
              parseSelectorHash(Buffer.from(row.csrf_selector_hash).toString("hex")) ||
            expected.encryptedSecrets.algorithm !== envelope.algorithm ||
            expected.encryptedSecrets.keyReference !== envelope.keyReference ||
            expected.encryptedSecrets.ciphertext !== envelope.ciphertext ||
            expected.encryptedSecrets.encryptionContext !== envelope.encryptionContext)
        )
          return denied();
        const plaintext = await decrypt.call(envelopes, envelope, envelope.encryptionContext);
        check();
        if (typeof plaintext !== "string" || plaintext.length > 16384) return denied();
        const secrets = parseWorkforceSessionSecrets(JSON.parse(plaintext), configuration, session);
        if (
          !equals.call(
            hasher,
            hash.call(hasher, secrets.csrf),
            parseSelectorHash(Buffer.from(row.csrf_selector_hash).toString("hex")),
          )
        )
          return denied();
        assertWorkforceSessionCurrent(session, secrets.mfa, latest);
        const { policy: originalPolicy, ...sessionFields } = session;
        void originalPolicy;
        const result = createAuthenticationSession({
          ...sessionFields,
          policyCode: session.policy.code,
          maxActiveSessions: session.policy.maxActiveSessions,
          idleTimeoutMinutes: session.policy.idleTimeoutMinutes,
          absoluteTimeoutMinutes: session.policy.absoluteTimeoutMinutes,
          actor: createIdentityActor({
            ...actor,
            verificationLevel: "RecentMfa",
            recentMfaAt: secrets.mfa.verifiedAt,
          }),
        });
        check();
        assertWorkforceSessionCurrent(result, secrets.mfa, latest);
        return result;
      }
      return session;
    } catch {
      return denied();
    }
  };
}
