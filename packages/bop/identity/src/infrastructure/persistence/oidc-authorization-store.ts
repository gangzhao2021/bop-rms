import { Buffer } from "node:buffer";
import {
  BrowserSessionError,
  createAuthorizationTransaction,
  parseExactHttpsUri,
  parseAuthorizationTransactionReference,
  parsePostLoginPath,
  parseSelectorHash,
  parseRawBrowserCredential,
  type AuthorizationTransaction,
  type EncryptedSecretEnvelope,
  type RawBrowserCredential,
} from "../../contracts/browser-session.js";
import { parseCanonicalInstant, readClosedRecord } from "../../contracts/identity-actor.js";
import type { BrowserSessionStorePort } from "../../application/ports/browser-session-store-port.js";
import type { SessionEnvelopeCryptoPort } from "../../application/ports/session-credential-ports.js";
import { parseSessionVersion } from "../../contracts/authentication-session.js";
import {
  parseWorkforceOnboardingConfiguration,
  workforceOnboardingInstant,
  type WorkforceOnboardingConfiguration,
} from "../../contracts/workforce-onboarding-operation.js";
import {
  parseWorkforceOnboardingInvitationBinding,
  type WorkforceOnboardingInvitationBinding,
} from "../../contracts/workforce-onboarding-invitation.js";

export interface OidcAuthorizationTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const invalid = (): never => {
  throw new BrowserSessionError("BROWSER_SESSION_DENIED");
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return invalid();
  const field = Object.getOwnPropertyDescriptor(value, "rows");
  if (!field || !("value" in field) || !Array.isArray(field.value) || field.value.length > 1)
    return invalid();
  return field.value;
}
function at(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return invalid();
  return value.toISOString();
}
function bytes(value: unknown, min: number, max: number): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength < min || value.byteLength > max)
    return invalid();
  return Buffer.from(value);
}
interface Options {
  transactions: { run<T>(work: (tx: OidcAuthorizationTransaction) => Promise<T>): Promise<T> };
  environment: string;
  redirectUri: string;
  allowedPostLoginPaths: readonly string[];
}
export function createPostgresOidcAuthorizationStore(options: Options) {
  return createStore(options, false);
}
export function createPostgresPlatformOidcAuthorizationStore(options: Options) {
  return createStore(options, true);
}
function createStore(
  options: Options,
  platform: boolean,
): Pick<
  BrowserSessionStorePort,
  "createAuthorizationTransaction" | "consumeAuthorizationTransaction"
> {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(options.environment)) return invalid();
  const environment = options.environment;
  const redirectUri = parseExactHttpsUri(options.redirectUri);
  const paths = Object.freeze([...options.allowedPostLoginPaths]);
  function envelope(value: EncryptedSecretEnvelope, reference: string) {
    if (
      !value ||
      !["SYNTHETIC_AES_256_GCM", "KMS_AES_256_GCM"].includes(value.algorithm) ||
      typeof value.keyReference !== "string" ||
      !/^[\x21-\x7e]{1,255}$/u.test(value.keyReference) ||
      value.encryptionContext !==
        environment + (platform ? ":platform-oidc:" : ":oidc:") + reference ||
      typeof value.ciphertext !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(value.ciphertext)
    )
      return invalid();
    const ciphertext = bytes(Buffer.from(value.ciphertext, "base64url"), 29, 8192);
    if (ciphertext.toString("base64url") !== value.ciphertext) return invalid();
    return Object.freeze({ ...value });
  }
  function validate(input: AuthorizationTransaction) {
    const result = createAuthorizationTransaction(input);
    if (result.redirectUri !== redirectUri) return invalid();
    parsePostLoginPath(result.postLoginPath, paths);
    return Object.freeze({
      ...result,
      encryptedSecrets: envelope(result.encryptedSecrets, result.transactionReference),
    });
  }
  return Object.freeze({
    async createAuthorizationTransaction(input) {
      try {
        const record = validate(input);
        if (record.consumedAt !== null || record.version !== 1) return invalid();
        const createdAt = new Date(Date.parse(record.expiresAt) - 600000).toISOString();
        const secret = record.encryptedSecrets;
        await options.transactions.run(async (tx) => {
          await tx.query(
            "INSERT INTO bop_identity.oidc_authorization_transaction (transaction_id,state_selector_hash,auth_cookie_selector_hash,encrypted_secret,cipher_algorithm,key_reference,encryption_context,redirect_uri,post_login_path,created_at,expires_at,consumed_at,version) VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,$5,$6,$7,$8,$9,$10,$11,NULL,1)",
            [
              record.transactionReference,
              record.stateSelectorHash,
              record.authCookieSelectorHash,
              Buffer.from(secret.ciphertext, "base64url"),
              secret.algorithm,
              secret.keyReference,
              secret.encryptionContext,
              record.redirectUri,
              record.postLoginPath,
              createdAt,
              record.expiresAt,
            ],
          );
        });
      } catch {
        return invalid();
      }
    },
    async consumeAuthorizationTransaction(command) {
      try {
        const state = parseSelectorHash(command.stateSelectorHash);
        const cookie = parseSelectorHash(command.authCookieSelectorHash);
        const consumedAt = parseCanonicalInstant(command.consumedAt);
        return await options.transactions.run(async (tx) => {
          const result = rows(
            await tx.query(
              "UPDATE bop_identity.oidc_authorization_transaction SET consumed_at=$3,version=version+1 WHERE state_selector_hash=decode($1,'hex') AND auth_cookie_selector_hash=decode($2,'hex') AND consumed_at IS NULL AND created_at <= $3 AND $3 < expires_at " +
                (platform
                  ? "AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at) "
                  : "") +
                "RETURNING *",
              [state, cookie, consumedAt],
            ),
          );
          const row = result[0];
          if (!row) return null;
          const reference = parseAuthorizationTransactionReference(row.transaction_id);
          const record = validate({
            transactionReference: reference,
            stateSelectorHash: bytes(row.state_selector_hash, 32, 32).toString("hex"),
            authCookieSelectorHash: bytes(row.auth_cookie_selector_hash, 32, 32).toString("hex"),
            encryptedSecrets: {
              algorithm: row.cipher_algorithm,
              keyReference: row.key_reference,
              ciphertext: bytes(row.encrypted_secret, 29, 8192).toString("base64url"),
              encryptionContext: row.encryption_context,
            },
            redirectUri: row.redirect_uri,
            postLoginPath: row.post_login_path,
            expiresAt: at(row.expires_at),
            consumedAt: at(row.consumed_at),
            version: row.version,
          } as AuthorizationTransaction);
          if (
            record.stateSelectorHash !== state ||
            record.authCookieSelectorHash !== cookie ||
            record.consumedAt !== consumedAt ||
            record.version !== 2 ||
            at(row.created_at) !== new Date(Date.parse(record.expiresAt) - 600000).toISOString()
          )
            return invalid();
          return record;
        });
      } catch {
        return invalid();
      }
    },
  });
}

export interface WorkforceOnboardingAuthorizationSourceOptions {
  readonly transaction: OidcAuthorizationTransaction;
  readonly configuration: WorkforceOnboardingConfiguration;
  readonly redirectUri: string;
  readonly allowedPostLoginPaths: readonly string[];
  readonly envelopes: SessionEnvelopeCryptoPort;
  readonly authorization: AuthorizationTransaction;
  readonly binding: WorkforceOnboardingInvitationBinding;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly registerBeforeCommit: (
    transaction: OidcAuthorizationTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => Promise<void>;
}
/** Server-only evidence. Nonce, verifier and the invitation binding must never
 * be returned by HTTP or recorded in logs, diagnostics or Audit. */
export interface WorkforceOnboardingAuthorizationEvidence {
  readonly authorization: AuthorizationTransaction;
  readonly binding: WorkforceOnboardingInvitationBinding;
  readonly nonce: RawBrowserCredential;
  readonly codeVerifier: RawBrowserCredential;
  readonly observedAt: string;
  readonly validUntil: string;
}
export interface WorkforceOnboardingAuthorizationSource {
  hold(): Promise<WorkforceOnboardingAuthorizationEvidence>;
  /** Pure state assertion after the real host has committed both guards. */
  assertFinalized(): void;
}
const onboardingAuthorizationOptionKeys = [
  "transaction",
  "configuration",
  "redirectUri",
  "allowedPostLoginPaths",
  "envelopes",
  "authorization",
  "binding",
  "clock",
  "originalObservedAt",
  "originalValidUntil",
  "registerBeforeCommit",
] as const;
function onboardingAuthorizationOne(value: unknown, keys: readonly string[]) {
  const d =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "rows")
      : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length !== 1 ||
    Reflect.ownKeys(d.value).length !== 2
  )
    return invalid();
  const row = Object.getOwnPropertyDescriptor(d.value, "0");
  if (!row?.enumerable || !("value" in row)) return invalid();
  return readClosedRecord(row.value, keys);
}
function onboardingAuthorizationPaths(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 100 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return invalid();
  const paths: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d) || typeof d.value !== "string") return invalid();
    paths.push(parsePostLoginPath(d.value, [d.value]));
  }
  if (new Set(paths).size !== paths.length) return invalid();
  return Object.freeze(paths);
}
/** Holds a consumed transaction; it neither consumes a second time nor turns
 * caller-supplied authorization data into proof of a persisted OIDC record. */
export function createPostgresWorkforceOnboardingAuthorizationSource(
  options: WorkforceOnboardingAuthorizationSourceOptions,
): WorkforceOnboardingAuthorizationSource {
  readClosedRecord(options, onboardingAuthorizationOptionKeys);
  const tx = options.transaction,
    queryPort = tx.query,
    configurationPort = options.configuration,
    configuration = parseWorkforceOnboardingConfiguration(configurationPort),
    redirectUri = parseExactHttpsUri(options.redirectUri),
    pathsPort = options.allowedPostLoginPaths,
    paths = onboardingAuthorizationPaths(pathsPort),
    envelopes = options.envelopes,
    decrypt = envelopes.decrypt,
    clock = options.clock,
    now = clock.now,
    register = options.registerBeforeCommit,
    authorizationPort = options.authorization,
    bindingPort = options.binding,
    binding = parseWorkforceOnboardingInvitationBinding(bindingPort),
    origin = workforceOnboardingInstant(options.originalObservedAt),
    originalEnd = workforceOnboardingInstant(options.originalValidUntil);
  if (
    [queryPort, decrypt, now, register].some((p) => typeof p !== "function") ||
    redirectUri !== options.redirectUri ||
    JSON.stringify(binding.configuration) !== JSON.stringify(configuration) ||
    origin >= originalEnd ||
    Date.parse(originalEnd) > Date.parse(origin) + 5000
  )
    return invalid();
  const parseAuthorization = (value: unknown): AuthorizationTransaction => {
    const r = readClosedRecord(value, [
        "transactionReference",
        "stateSelectorHash",
        "authCookieSelectorHash",
        "encryptedSecrets",
        "redirectUri",
        "postLoginPath",
        "expiresAt",
        "consumedAt",
        "version",
      ]),
      reference = parseAuthorizationTransactionReference(r.transactionReference),
      e = readClosedRecord(r.encryptedSecrets, [
        "algorithm",
        "keyReference",
        "ciphertext",
        "encryptionContext",
      ]);
    if (
      (e.algorithm !== "SYNTHETIC_AES_256_GCM" && e.algorithm !== "KMS_AES_256_GCM") ||
      typeof e.keyReference !== "string" ||
      !/^[\x21-\x7e]{1,255}$/u.test(e.keyReference) ||
      typeof e.ciphertext !== "string" ||
      !/^[A-Za-z0-9_-]+$/u.test(e.ciphertext) ||
      e.encryptionContext !== `${configuration.environment}:oidc:${reference}` ||
      bytes(Buffer.from(e.ciphertext, "base64url"), 29, 8192).toString("base64url") !==
        e.ciphertext ||
      r.redirectUri !== redirectUri ||
      r.version !== 2
    )
      return invalid();
    const consumedAt = parseCanonicalInstant(workforceOnboardingInstant(r.consumedAt)),
      expiresAt = parseCanonicalInstant(workforceOnboardingInstant(r.expiresAt));
    if (consumedAt > origin || consumedAt >= expiresAt) return invalid();
    return createAuthorizationTransaction({
      transactionReference: reference,
      stateSelectorHash: parseSelectorHash(r.stateSelectorHash),
      authCookieSelectorHash: parseSelectorHash(r.authCookieSelectorHash),
      encryptedSecrets: Object.freeze({
        algorithm: e.algorithm,
        keyReference: e.keyReference,
        ciphertext: e.ciphertext,
        encryptionContext: e.encryptionContext,
      }),
      redirectUri,
      postLoginPath: parsePostLoginPath(r.postLoginPath, paths),
      expiresAt,
      consumedAt,
      version: parseSessionVersion(r.version),
    });
  };
  const expected = parseAuthorization(authorizationPort),
    expectedPin = JSON.stringify(expected),
    bindingPin = JSON.stringify(binding),
    configurationPin = JSON.stringify(configuration),
    pathsPin = JSON.stringify(paths);
  let phase: "Open" | "Ready" | "Final" | "Poison" = "Open",
    busy = false,
    registered = false,
    guarded = false,
    latest: string = origin,
    txid: string | undefined,
    secretPin: string | undefined;
  const deadline = expected.expiresAt < originalEnd ? expected.expiresAt : originalEnd;
  const poison = (): never => {
    phase = "Poison";
    return invalid();
  };
  const check = () => {
    try {
      const o = readClosedRecord(options, onboardingAuthorizationOptionKeys),
        at = workforceOnboardingInstant(now.call(clock));
      if (
        phase === "Poison" ||
        phase === "Final" ||
        o.transaction !== tx ||
        tx.query !== queryPort ||
        o.configuration !== configurationPort ||
        JSON.stringify(parseWorkforceOnboardingConfiguration(configurationPort)) !==
          configurationPin ||
        o.redirectUri !== redirectUri ||
        o.allowedPostLoginPaths !== pathsPort ||
        JSON.stringify(onboardingAuthorizationPaths(pathsPort)) !== pathsPin ||
        o.envelopes !== envelopes ||
        envelopes.decrypt !== decrypt ||
        o.clock !== clock ||
        clock.now !== now ||
        o.registerBeforeCommit !== register ||
        o.authorization !== authorizationPort ||
        JSON.stringify(parseAuthorization(authorizationPort)) !== expectedPin ||
        o.binding !== bindingPort ||
        JSON.stringify(parseWorkforceOnboardingInvitationBinding(bindingPort)) !== bindingPin ||
        o.originalObservedAt !== origin ||
        o.originalValidUntil !== originalEnd ||
        at < latest ||
        at >= deadline
      )
        return poison();
      latest = at;
      return at;
    } catch {
      return poison();
    }
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    const result = await queryPort.call(tx, sql, values);
    check();
    return result;
  };
  const sameTx = async () => {
    const r = onboardingAuthorizationOne(
      await query(
        "SELECT current_setting('transaction_isolation') AS isolation,pg_current_xact_id()::text AS transaction_id",
        [],
      ),
      ["isolation", "transaction_id"],
    );
    if (
      r.isolation !== "read committed" ||
      typeof r.transaction_id !== "string" ||
      !/^[1-9][0-9]{0,19}$/u.test(r.transaction_id) ||
      (txid !== undefined && txid !== r.transaction_id)
    )
      return poison();
    txid = r.transaction_id;
  };
  const read = async (): Promise<WorkforceOnboardingAuthorizationEvidence> => {
    await sameTx();
    await sameTx();
    const r = onboardingAuthorizationOne(
      await query(
        `SELECT transaction_id::text AS transaction_id,encode(state_selector_hash,'hex') AS state_selector_hash,
       encode(auth_cookie_selector_hash,'hex') AS auth_cookie_selector_hash,encrypted_secret,
       cipher_algorithm,key_reference,encryption_context,redirect_uri,post_login_path,
       to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
       to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
       to_char(consumed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS consumed_at,version,
       (isfinite(created_at) AND isfinite(expires_at) AND isfinite(consumed_at)
        AND created_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND created_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
        AND expires_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND expires_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
        AND consumed_at >= TIMESTAMPTZ '0001-01-01 00:00:00+00' AND consumed_at < TIMESTAMPTZ '10000-01-01 00:00:00+00'
        AND created_at=date_trunc('milliseconds',created_at) AND expires_at=date_trunc('milliseconds',expires_at)
        AND consumed_at=date_trunc('milliseconds',consumed_at)) AS precise
       FROM bop_identity.oidc_authorization_transaction
       WHERE transaction_id=$1 AND state_selector_hash=decode($2,'hex') AND auth_cookie_selector_hash=decode($3,'hex') FOR SHARE`,
        [
          expected.transactionReference,
          expected.stateSelectorHash,
          expected.authCookieSelectorHash,
        ],
      ),
      [
        "transaction_id",
        "state_selector_hash",
        "auth_cookie_selector_hash",
        "encrypted_secret",
        "cipher_algorithm",
        "key_reference",
        "encryption_context",
        "redirect_uri",
        "post_login_path",
        "created_at",
        "expires_at",
        "consumed_at",
        "version",
        "precise",
      ],
    );
    if (r.precise !== true) return poison();
    const actual = parseAuthorization({
        transactionReference: r.transaction_id,
        stateSelectorHash: r.state_selector_hash,
        authCookieSelectorHash: r.auth_cookie_selector_hash,
        encryptedSecrets: {
          algorithm: r.cipher_algorithm,
          keyReference: r.key_reference,
          encryptionContext: r.encryption_context,
          ciphertext: bytes(r.encrypted_secret, 29, 8192).toString("base64url"),
        },
        redirectUri: r.redirect_uri,
        postLoginPath: r.post_login_path,
        expiresAt: r.expires_at,
        consumedAt: r.consumed_at,
        version: r.version,
      }),
      createdAt = workforceOnboardingInstant(r.created_at);
    if (
      JSON.stringify(actual) !== expectedPin ||
      actual.consumedAt === null ||
      createdAt > actual.consumedAt ||
      Date.parse(createdAt) + 600000 !== Date.parse(actual.expiresAt)
    )
      return poison();
    const plaintext = await decrypt.call(
      envelopes,
      actual.encryptedSecrets,
      `${configuration.environment}:oidc:${actual.transactionReference}`,
    );
    check();
    if (typeof plaintext !== "string" || Buffer.byteLength(plaintext, "utf8") > 8192)
      return poison();
    const secrets = readClosedRecord(JSON.parse(plaintext), [
        "profile",
        "nonce",
        "codeVerifier",
        "startedAt",
        "previous",
        "binding",
      ]),
      actualBinding = parseWorkforceOnboardingInvitationBinding(secrets.binding),
      nonce = parseRawBrowserCredential(secrets.nonce),
      codeVerifier = parseRawBrowserCredential(secrets.codeVerifier),
      startedAt = workforceOnboardingInstant(secrets.startedAt);
    if (
      secrets.profile !== "WorkforceOnboardingOidcV1" ||
      secrets.previous !== null ||
      startedAt !== createdAt ||
      JSON.stringify(actualBinding) !== bindingPin
    )
      return poison();
    const pin = JSON.stringify({ nonce, codeVerifier, startedAt, binding: actualBinding });
    if (secretPin !== undefined && pin !== secretPin) return poison();
    secretPin = pin;
    await sameTx();
    check();
    return Object.freeze({
      authorization: actual,
      binding: actualBinding,
      nonce,
      codeVerifier,
      observedAt: origin,
      validUntil: deadline,
    });
  };
  const guard = async () => {
    if (busy || phase !== "Ready" || guarded) return poison();
    busy = true;
    try {
      await read();
      check();
      guarded = true;
    } catch {
      return poison();
    } finally {
      busy = false;
    }
  };
  const final = () => {
    if (busy || phase !== "Ready" || !guarded) return poison();
    check();
    phase = "Final";
  };
  return Object.freeze({
    async hold() {
      if (busy || phase === "Final" || phase === "Poison") return poison();
      busy = true;
      try {
        if (!registered) {
          registered = true;
          await register(tx, guard, final);
        }
        check();
        const result = await read();
        check();
        phase = "Ready";
        return result;
      } catch {
        return poison();
      } finally {
        busy = false;
      }
    },
    assertFinalized() {
      if (phase !== "Final" || busy || !guarded) return poison();
    },
  });
}
