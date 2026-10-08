import { Buffer } from "node:buffer";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  assertSessionUsable,
  createAuthenticationSession,
  parseSessionReference,
  parseSessionVersion,
  sessionPolicies,
  type AuthenticationSession,
  type SessionPolicyCode,
} from "../../contracts/authentication-session.js";
import {
  BrowserSessionError,
  createBrowserSessionRecord,
  parseSelectorHash,
  type BrowserSessionRecord,
  type EncryptedSecretEnvelope,
} from "../../contracts/browser-session.js";
import {
  createIdentityActor,
  parseCanonicalInstant,
  type IdentityActor,
  type CanonicalInstant,
} from "../../contracts/identity-actor.js";
import type { BrowserSessionStorePort } from "../../application/ports/browser-session-store-port.js";
import {
  createPostgresOidcAuthorizationStore,
  createPostgresPlatformOidcAuthorizationStore,
  type OidcAuthorizationTransaction,
} from "./oidc-authorization-store.js";

import {
  assertPlatformSessionCurrent,
  parsePlatformSessionSecrets,
  type PlatformBrowserSessionStorePort,
  type ReplacePlatformSessionCommand,
} from "../../contracts/platform-browser-session.js";
import {
  assertWorkforceSessionCurrent,
  parseWorkforceSessionSecrets,
  type WorkforceBrowserSessionStorePort,
  type ReplaceWorkforceSessionCommand,
} from "../../contracts/workforce-browser-session.js";
import type {
  BrowserCredentialHasherPort,
  SessionEnvelopeCryptoPort,
} from "../../application/ports/session-credential-ports.js";

const denied = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (!result || typeof result !== "object") return denied();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1024) return denied();
  return d.value;
}
function at(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return denied();
  return value.toISOString();
}
function bytes(value: unknown, min: number, max: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max)
    return denied();
  return Buffer.from(value);
}
interface Options {
  transactions: { run<T>(work: (tx: OidcAuthorizationTransaction) => Promise<T>): Promise<T> };
  environment: string;
  redirectUri: string;
  allowedPostLoginPaths: readonly string[];
  now(): string;
  onSessionCreated?(tx: OidcAuthorizationTransaction, record: BrowserSessionRecord): Promise<void>;
  currentActor(
    tx: OidcAuthorizationTransaction,
    reference: string,
    authenticatedAt: CanonicalInstant,
    observedAt: CanonicalInstant,
  ): Promise<IdentityActor>;
}
type PlatformOptions = Options & {
  issuer: string;
  clientId: string;
  envelopes: SessionEnvelopeCryptoPort;
  hasher: BrowserCredentialHasherPort;
};
type Profile =
  | { readonly kind: "Workforce"; readonly options?: PlatformOptions }
  | { readonly kind: "Platform"; readonly options: PlatformOptions };
export function createPostgresBrowserSessionStore(options: Options): BrowserSessionStorePort {
  const store = createStore(options, { kind: "Workforce" });
  return Object.freeze({
    createAuthorizationTransaction: store.createAuthorizationTransaction,
    consumeAuthorizationTransaction: store.consumeAuthorizationTransaction,
    createSession: store.createSession,
    resolveSession: store.resolveSession,
    rotateSession: store.rotateSession,
    revokeSession: store.revokeSession,
  });
}
export function createPostgresPlatformBrowserSessionStore(
  options: PlatformOptions,
): PlatformBrowserSessionStorePort {
  const store = createStore(options, { kind: "Platform", options });
  return Object.freeze({
    createAuthorizationTransaction: store.createAuthorizationTransaction,
    consumeAuthorizationTransaction: store.consumeAuthorizationTransaction,
    createSession: store.createSession,
    resolveSession: store.resolveSession,
    replaceAfterStepUp: store.replaceAfterStepUp,
    revokeSession: store.revokeSession,
  });
}
export function createPostgresWorkforceBrowserSessionStore(
  options: PlatformOptions,
): WorkforceBrowserSessionStorePort {
  const store = createStore(options, { kind: "Workforce", options });
  return Object.freeze({
    createAuthorizationTransaction: store.createAuthorizationTransaction,
    consumeAuthorizationTransaction: store.consumeAuthorizationTransaction,
    createSession: store.createSession,
    resolveSession: store.resolveSession,
    replaceAfterStepUp: store.replaceAfterStepUp,
    revokeSession: store.revokeSession,
  });
}
function createStore(options: Options, profile: Profile) {
  const strong = profile.options !== undefined;
  const assertStrongCurrent =
    profile.kind === "Platform" ? assertPlatformSessionCurrent : assertWorkforceSessionCurrent;
  const oidc =
    profile.kind === "Platform"
      ? createPostgresPlatformOidcAuthorizationStore(options)
      : createPostgresOidcAuthorizationStore(options);
  const environment = options.environment;
  const strongIssuer = profile.options?.issuer,
    strongClientId = profile.options?.clientId;
  const actorPort = options.currentActor,
    nowPort = options.now,
    createdPort = options.onSessionCreated;
  const platformCrypto = profile.options?.envelopes ?? null;
  const platformDecrypt = platformCrypto?.decrypt;
  const platformHasher = profile.options?.hasher ?? null;
  const platformHash = platformHasher?.hash,
    platformEquals = platformHasher?.equals;
  function envelope(input: EncryptedSecretEnvelope, session: AuthenticationSession) {
    if (
      !input ||
      !["SYNTHETIC_AES_256_GCM", "KMS_AES_256_GCM"].includes(input.algorithm) ||
      typeof input.keyReference !== "string" ||
      !/^[\x21-\x7e]{1,255}$/u.test(input.keyReference) ||
      input.encryptionContext !==
        environment +
          (profile.kind === "Platform" ? ":platform-session:" : ":session:") +
          session.sessionReference +
          ":" +
          session.actor.actorReference ||
      typeof input.ciphertext !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(input.ciphertext)
    )
      return denied();
    const raw = bytes(Buffer.from(input.ciphertext, "base64url"), 29, 16384);
    if (raw.toString("base64url") !== input.ciphertext) return denied();
    return Object.freeze({ ...input });
  }
  async function actor(
    tx: OidcAuthorizationTransaction,
    reference: string,
    authenticatedAt: CanonicalInstant,
    observedAt: CanonicalInstant,
  ) {
    const result = createIdentityActor(
      await (strong
        ? actorPort.call(options, tx, reference, authenticatedAt, observedAt)
        : options.currentActor(tx, reference, authenticatedAt, observedAt)),
    );
    if (
      result.actorReference !== reference ||
      result.authenticatedAt !== authenticatedAt ||
      result.actorType !== "User" ||
      result.accountKind !== profile.kind ||
      result.authenticationMethod !== "Oidc" ||
      (strong &&
        profile.kind === "Workforce" &&
        (result.verificationLevel !== "SingleFactor" || result.recentMfaAt !== null))
    )
      return denied();
    // Directory MFA metadata is not proof about this Session. The encrypted
    // Platform proof is returned separately after its exact Session binding is checked.
    return strong
      ? createIdentityActor({ ...result, verificationLevel: "SingleFactor", recentMfaAt: null })
      : result;
  }
  async function decode(
    tx: OidcAuthorizationTransaction,
    row: Record<string, unknown>,
    observedAt: CanonicalInstant,
  ) {
    if (typeof row.actor_id !== "string") return denied();
    const policy = Object.values(sessionPolicies).find((p) => p.code === row.policy_code);
    if (!policy || (strong && policy.code !== "Privileged")) return denied();
    const authenticatedAt = parseCanonicalInstant(at(row.authenticated_at));
    const current = await actor(tx, row.actor_id, authenticatedAt, observedAt);
    const session = createAuthenticationSession({
      sessionReference: row.session_id,
      actor: current,
      status: row.status,
      policyCode: policy.code,
      maxActiveSessions: policy.maxActiveSessions,
      idleTimeoutMinutes: policy.idleTimeoutMinutes,
      absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
      version: row.version,
      authenticatedAt,
      createdAt: at(row.created_at),
      lastSeenAt: at(row.last_seen_at),
      idleExpiresAt: at(row.idle_expires_at),
      absoluteExpiresAt: at(row.absolute_expires_at),
      rotatedFromSessionReference: row.rotated_from_session_id,
      revocationReason: row.revocation_reason,
      revokedAt: row.revoked_at === null ? null : at(row.revoked_at),
    });
    if (Date.parse(session.lastSeenAt) > Date.parse(observedAt)) return denied();
    const encryptedSecrets = envelope(
      {
        algorithm: row.cipher_algorithm,
        keyReference: row.key_reference,
        ciphertext: bytes(row.encrypted_secret, 29, 16384).toString("base64url"),
        encryptionContext: row.encryption_context,
      } as EncryptedSecretEnvelope,
      session,
    );
    const record = createBrowserSessionRecord({
      session,
      encryptedSecrets,
      sessionSelectorHash: bytes(row.session_selector_hash, 32, 32).toString("hex"),
      csrfSelectorHash: bytes(row.csrf_selector_hash, 32, 32).toString("hex"),
    });
    await platformSecrets(record);
    return record;
  }
  async function platformSecrets(record: BrowserSessionRecord) {
    if (!strong || !profile.options) return null;
    const p = profile.options;
    if (
      !platformCrypto ||
      !platformDecrypt ||
      !platformHasher ||
      !platformHash ||
      !platformEquals ||
      (profile.kind === "Workforce" &&
        (p.issuer !== strongIssuer ||
          p.clientId !== strongClientId ||
          options.environment !== environment)) ||
      p.envelopes !== platformCrypto ||
      platformCrypto.decrypt !== platformDecrypt ||
      p.hasher !== platformHasher ||
      platformHasher.hash !== platformHash ||
      platformHasher.equals !== platformEquals
    )
      return denied();
    const plaintext = await platformDecrypt.call(
      platformCrypto,
      record.encryptedSecrets,
      record.encryptedSecrets.encryptionContext,
    );
    if (
      profile.kind === "Workforce" &&
      (p.issuer !== strongIssuer ||
        p.clientId !== strongClientId ||
        options.environment !== environment ||
        p.envelopes !== platformCrypto ||
        platformCrypto.decrypt !== platformDecrypt ||
        p.hasher !== platformHasher ||
        platformHasher.hash !== platformHash ||
        platformHasher.equals !== platformEquals)
    )
      return denied();
    if (plaintext.length > 16_384) return denied();
    const value: unknown = JSON.parse(plaintext);
    const secrets =
      profile.kind === "Platform"
        ? parsePlatformSessionSecrets(value, p, record.session)
        : parseWorkforceSessionSecrets(value, p, record.session);
    if (
      !platformEquals.call(
        platformHasher,
        platformHash.call(platformHasher, secrets.csrf),
        record.csrfSelectorHash,
      )
    )
      return denied();
    return secrets;
  }
  async function platformFinal(
    tx: OidcAuthorizationTransaction,
    record: BrowserSessionRecord,
    startedAt: CanonicalInstant,
    query: OidcAuthorizationTransaction["query"],
  ) {
    if (!strong) return;
    const s = record.session;
    if (s.actor.actorReference === null) return denied();
    const held = await load(
      tx,
      record.sessionSelectorHash,
      parseCanonicalInstant(options.now()),
      true,
    );
    // Both records were reconstructed by owning parsers. JSON property insertion
    // order is transport representation; every actual value must still match.
    if (!held || canonicalizeRfc8785(held) !== canonicalizeRfc8785(record)) return denied();
    const secrets = await platformSecrets(held);
    const now = parseCanonicalInstant(options.now());
    if (
      !secrets ||
      tx.query !== query ||
      now < startedAt ||
      Date.parse(now) >= Date.parse(startedAt) + 5000
    )
      return denied();
    assertStrongCurrent(s, secrets.mfa, now);
  }
  async function load(
    tx: OidcAuthorizationTransaction,
    hash: unknown,
    observedAt: CanonicalInstant,
    write = false,
  ) {
    const selector = parseSelectorHash(hash);
    const found = rows(
      await tx.query(
        "SELECT * FROM bop_identity.authentication_session WHERE session_selector_hash=decode($1,'hex') " +
          (strong
            ? "AND authenticated_at=date_trunc('milliseconds',authenticated_at) AND created_at=date_trunc('milliseconds',created_at) AND last_seen_at=date_trunc('milliseconds',last_seen_at) AND idle_expires_at=date_trunc('milliseconds',idle_expires_at) AND absolute_expires_at=date_trunc('milliseconds',absolute_expires_at) AND (revoked_at IS NULL OR revoked_at=date_trunc('milliseconds',revoked_at)) "
            : "") +
          (write ? "FOR UPDATE" : "FOR SHARE"),
        [selector],
      ),
    );
    if (found.length > 1) return denied();
    const row = found[0];
    return row ? decode(tx, row, observedAt) : null;
  }
  async function lock(tx: OidcAuthorizationTransaction) {
    await tx.query(
      "LOCK TABLE bop_identity.authentication_session IN SHARE ROW EXCLUSIVE MODE",
      [],
    );
  }
  function newSession(
    reference: unknown,
    current: IdentityActor,
    policyCode: SessionPolicyCode,
    observedAt: CanonicalInstant,
    version = 1,
    rotatedFrom: string | null = null,
  ) {
    const policy = Object.values(sessionPolicies).find((p) => p.code === policyCode);
    if (!policy || (strong && policy.code !== "Privileged")) return denied();
    return createAuthenticationSession({
      sessionReference: parseSessionReference(reference),
      actor: current,
      status: "Active",
      policyCode,
      maxActiveSessions: policy.maxActiveSessions,
      idleTimeoutMinutes: policy.idleTimeoutMinutes,
      absoluteTimeoutMinutes: policy.absoluteTimeoutMinutes,
      version,
      authenticatedAt: current.authenticatedAt,
      createdAt: observedAt,
      lastSeenAt: observedAt,
      idleExpiresAt: new Date(
        Date.parse(observedAt) + policy.idleTimeoutMinutes * 60000,
      ).toISOString(),
      absoluteExpiresAt: new Date(
        Date.parse(observedAt) + policy.absoluteTimeoutMinutes * 60000,
      ).toISOString(),
      rotatedFromSessionReference: rotatedFrom,
      revocationReason: null,
      revokedAt: null,
    });
  }
  async function insert(tx: OidcAuthorizationTransaction, record: BrowserSessionRecord) {
    const s = record.session,
      e = record.encryptedSecrets;
    await tx.query(
      "INSERT INTO bop_identity.authentication_session (session_id,actor_id,session_selector_hash,csrf_selector_hash,policy_code,status,encrypted_secret,cipher_algorithm,key_reference,encryption_context,authenticated_at,created_at,last_seen_at,idle_expires_at,absolute_expires_at,rotated_from_session_id,version) VALUES ($1,$2,decode($3,'hex'),decode($4,'hex'),$5,'Active',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)",
      [
        s.sessionReference,
        s.actor.actorReference,
        record.sessionSelectorHash,
        record.csrfSelectorHash,
        s.policy.code,
        Buffer.from(e.ciphertext, "base64url"),
        e.algorithm,
        e.keyReference,
        e.encryptionContext,
        s.authenticatedAt,
        s.createdAt,
        s.lastSeenAt,
        s.idleExpiresAt,
        s.absoluteExpiresAt,
        s.rotatedFromSessionReference,
        s.version,
      ],
    );
  }
  async function safe<T>(work: (tx: OidcAuthorizationTransaction) => Promise<T>): Promise<T> {
    try {
      return await options.transactions.run(async (tx) => {
        if (!strong) return work(tx);
        const query = tx.query,
          startedAt = parseCanonicalInstant(nowPort());
        const result = await work(tx);
        const at = parseCanonicalInstant(nowPort());
        if (
          tx.query !== query ||
          options.currentActor !== actorPort ||
          options.now !== nowPort ||
          options.onSessionCreated !== createdPort ||
          at < startedAt ||
          Date.parse(at) >= Date.parse(startedAt) + 5000
        )
          return denied();
        return result;
      });
    } catch (error) {
      if (error instanceof BrowserSessionError && error.code === "BROWSER_SESSION_VERSION_CONFLICT")
        throw error;
      return denied();
    }
  }
  return Object.freeze({
    ...oidc,
    async createSession(command: Parameters<BrowserSessionStorePort["createSession"]>[0]) {
      return safe(async (tx) => {
        const observedAt = parseCanonicalInstant(command.observedAt);
        const originalQuery = tx.query;
        const supplied = createIdentityActor(command.actor);
        if (supplied.actorReference === null) return denied();
        // Platform directory lifecycle changes lock Sessions before the Actor
        // head. Take the same order before currentActor acquires that head.
        if (strong) await lock(tx);
        const current = await actor(
          tx,
          supplied.actorReference,
          supplied.authenticatedAt,
          observedAt,
        );
        const session = newSession(
          command.sessionReference,
          current,
          command.policyCode,
          observedAt,
        );
        const record = createBrowserSessionRecord({
          session,
          sessionSelectorHash: command.sessionSelectorHash,
          csrfSelectorHash: command.csrfSelectorHash,
          encryptedSecrets: envelope(command.encryptedSecrets, session),
        });
        const proof = await platformSecrets(record);
        if (proof) assertStrongCurrent(record.session, proof.mfa, observedAt);
        if (!strong) await lock(tx);
        const active = rows(
          await tx.query(
            "SELECT session_id,created_at" +
              (strong
                ? ",created_at=date_trunc('milliseconds',created_at) AS exact_created_at"
                : "") +
              " FROM bop_identity.authentication_session WHERE actor_id=$1 AND status='Active' AND idle_expires_at>$2 AND absolute_expires_at>$2 ORDER BY created_at,session_id LIMIT 1025 FOR UPDATE",
            [current.actorReference, observedAt],
          ),
        );
        if (active.some((r) => at(r.created_at) > observedAt)) return denied();
        if (strong) {
          const references = active.map((r) => {
            if (r.exact_created_at !== true) return denied();
            return parseSessionReference(r.session_id);
          });
          if (new Set(references).size !== references.length) return denied();
        }
        for (const oldest of active.slice(
          0,
          Math.max(0, active.length - session.policy.maxActiveSessions + 1),
        )) {
          await tx.query(
            "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='ConcurrentLimit',revoked_at=$2,version=version+1 WHERE session_id=$1",
            [oldest.session_id, observedAt],
          );
        }
        await insert(tx, record);
        await options.onSessionCreated?.(tx, record);
        await platformFinal(tx, record, observedAt, originalQuery);
        return record;
      });
    },
    async resolveSession(selectorHash: Parameters<BrowserSessionStorePort["resolveSession"]>[0]) {
      return safe(async (tx) => load(tx, selectorHash, parseCanonicalInstant(options.now())));
    },
    async rotateSession(command: Parameters<BrowserSessionStorePort["rotateSession"]>[0]) {
      if (strong) return denied();
      return safe(async (tx) => {
        const observedAt = parseCanonicalInstant(command.observedAt);
        if (
          ![
            "Login",
            "MfaCompletion",
            "PrivilegeElevation",
            "StoreContextElevation",
            "Recovery",
            "RiskChange",
          ].includes(command.reason)
        )
          return denied();
        await lock(tx);
        const current = await load(tx, command.currentSelectorHash, observedAt, true);
        if (!current || current.session.version !== parseSessionVersion(command.expectedVersion))
          throw new BrowserSessionError("BROWSER_SESSION_VERSION_CONFLICT");
        const original = assertSessionUsable(current.session, observedAt);
        const session = newSession(
          command.nextSessionReference,
          original.actor,
          original.policy.code,
          observedAt,
          original.version + 1,
          original.sessionReference,
        );
        const record = createBrowserSessionRecord({
          session,
          sessionSelectorHash: command.nextSelectorHash,
          csrfSelectorHash: command.nextCsrfSelectorHash,
          encryptedSecrets: envelope(command.nextEncryptedSecrets, session),
        });
        if (
          record.sessionSelectorHash === current.sessionSelectorHash ||
          record.csrfSelectorHash === current.csrfSelectorHash
        )
          return denied();
        await tx.query(
          "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='RiskChange',revoked_at=$2,version=version+1 WHERE session_id=$1",
          [original.sessionReference, observedAt],
        );
        await insert(tx, record);
        await options.onSessionCreated?.(tx, record);
        return record;
      });
    },
    async replaceAfterStepUp(
      command: ReplacePlatformSessionCommand | ReplaceWorkforceSessionCommand,
    ) {
      if (!strong) return denied();
      return safe(async (tx) => {
        const observedAt = parseCanonicalInstant(command.observedAt),
          originalQuery = tx.query;
        await lock(tx);
        const current = await load(tx, command.currentSelectorHash, observedAt, true);
        if (
          !current ||
          current.session.sessionReference !== command.expectedSessionReference ||
          current.session.version !== parseSessionVersion(command.expectedVersion)
        )
          throw new BrowserSessionError("BROWSER_SESSION_VERSION_CONFLICT");
        const original = assertSessionUsable(current.session, observedAt);
        const supplied = createIdentityActor(command.actor);
        if (
          supplied.actorReference === null ||
          supplied.actorReference !== original.actor.actorReference ||
          supplied.authenticatedAt < original.authenticatedAt
        )
          return denied();
        const actual = await actor(
          tx,
          supplied.actorReference,
          supplied.authenticatedAt,
          observedAt,
        );
        const session = newSession(
          command.nextSessionReference,
          actual,
          "Privileged",
          observedAt,
          original.version + 1,
          original.sessionReference,
        );
        const record = createBrowserSessionRecord({
          session,
          sessionSelectorHash: command.nextSelectorHash,
          csrfSelectorHash: command.nextCsrfSelectorHash,
          encryptedSecrets: envelope(command.nextEncryptedSecrets, session),
        });
        const previous = await platformSecrets(current),
          next = await platformSecrets(record);
        if (
          !previous ||
          !next ||
          session.sessionReference === original.sessionReference ||
          record.sessionSelectorHash === current.sessionSelectorHash ||
          record.csrfSelectorHash === current.csrfSelectorHash ||
          next.mfa.authorizationTransactionReference ===
            previous.mfa.authorizationTransactionReference ||
          next.mfa.evidenceReference === previous.mfa.evidenceReference ||
          next.mfa.verifiedAt < original.createdAt
        )
          return denied();
        assertStrongCurrent(session, next.mfa, observedAt);
        await tx.query(
          "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason='RiskChange',revoked_at=$2,version=version+1 WHERE session_id=$1",
          [original.sessionReference, observedAt],
        );
        await insert(tx, record);
        await options.onSessionCreated?.(tx, record);
        await platformFinal(tx, record, observedAt, originalQuery);
        return record;
      });
    },
    async revokeSession(command: Parameters<BrowserSessionStorePort["revokeSession"]>[0]) {
      return safe(async (tx) => {
        const observedAt = parseCanonicalInstant(command.observedAt);
        await lock(tx);
        const current = await load(tx, command.selectorHash, observedAt, true);
        if (!current) return null;
        const s = current.session;
        if (s.version !== parseSessionVersion(command.expectedVersion))
          throw new BrowserSessionError("BROWSER_SESSION_VERSION_CONFLICT");
        if (s.status !== "Active") return denied();
        const revoked = createAuthenticationSession({
          sessionReference: s.sessionReference,
          actor: s.actor,
          status: "Revoked",
          policyCode: s.policy.code,
          maxActiveSessions: s.policy.maxActiveSessions,
          idleTimeoutMinutes: s.policy.idleTimeoutMinutes,
          absoluteTimeoutMinutes: s.policy.absoluteTimeoutMinutes,
          version: s.version + 1,
          authenticatedAt: s.authenticatedAt,
          createdAt: s.createdAt,
          lastSeenAt: s.lastSeenAt,
          idleExpiresAt: s.idleExpiresAt,
          absoluteExpiresAt: s.absoluteExpiresAt,
          rotatedFromSessionReference: s.rotatedFromSessionReference,
          revocationReason: command.reason,
          revokedAt: observedAt,
        });
        await tx.query(
          "UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason=$2,revoked_at=$3,version=version+1 WHERE session_id=$1",
          [s.sessionReference, command.reason, observedAt],
        );
        return revoked;
      });
    },
  });
}

/**
 * WP-2423 step 9: signs a workforce member out everywhere at once — e.g. when they leave a Store or
 * lose access. Which Brand a session works in is private to that session (row security), so all
 * their active sessions end; where they still work they sign in again. Returns how many ended;
 * caller owns the transaction.
 */
export async function revokeActorSessions(
  tx: {
    query(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  },
  input: {
    readonly actorReference: string;
    readonly reason: "StoreAssignmentRemoved" | "RoleRemoved" | "MembershipDisabled";
    readonly at: string;
  },
): Promise<number> {
  const rows = (
    await tx.query(
      `UPDATE bop_identity.authentication_session SET status='Revoked',revocation_reason=$2,revoked_at=$3,version=version+1
       WHERE actor_id=$1 AND status='Active' AND created_at<=$3 RETURNING session_id`,
      [input.actorReference, input.reason, input.at],
    )
  ).rows;
  return rows.length;
}
