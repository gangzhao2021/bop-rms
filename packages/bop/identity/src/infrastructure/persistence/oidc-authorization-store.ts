import { Buffer } from "node:buffer";
import {
  BrowserSessionError,
  createAuthorizationTransaction,
  parseExactHttpsUri,
  parseAuthorizationTransactionReference,
  parsePostLoginPath,
  parseSelectorHash,
  type AuthorizationTransaction,
  type EncryptedSecretEnvelope,
} from "../../contracts/browser-session.js";
import { parseCanonicalInstant } from "../../contracts/identity-actor.js";
import type { BrowserSessionStorePort } from "../../application/ports/browser-session-store-port.js";

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
export function createPostgresOidcAuthorizationStore(options: {
  transactions: { run<T>(work: (tx: OidcAuthorizationTransaction) => Promise<T>): Promise<T> };
  environment: string;
  redirectUri: string;
  allowedPostLoginPaths: readonly string[];
}): Pick<
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
      value.encryptionContext !== environment + ":oidc:" + reference ||
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
              "UPDATE bop_identity.oidc_authorization_transaction SET consumed_at=$3,version=version+1 WHERE state_selector_hash=decode($1,'hex') AND auth_cookie_selector_hash=decode($2,'hex') AND consumed_at IS NULL AND created_at <= $3 AND $3 < expires_at RETURNING *",
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
