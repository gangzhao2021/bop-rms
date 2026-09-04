import {
  assertGuestSessionUsable,
  createGuestSessionRecord,
  GuestSessionError,
  parseGuestOperationReference,
  parseGuestSelectorHash,
  type GuestSessionRecord,
} from "../../contracts/guest-session.js";
import { parseCanonicalInstant, parseOpaqueUuidV7 } from "../../contracts/identity-actor.js";
import type { GuestSessionStorePort } from "../../application/ports/guest-session-ports.js";

export interface GuestSessionEntryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

export interface GuestSessionEntryTransactionRunner {
  // Use one dedicated transaction/connection, commit before resolving, and never auto-retry.
  run<T>(action: (transaction: GuestSessionEntryTransaction) => Promise<T>): Promise<T>;
}

export type GuestSessionEntryStore = Pick<
  GuestSessionStorePort,
  "create" | "resolve" | "resolveOperation" | "touchInteractive"
>;

const projection = `jsonb_build_object(
  'session', jsonb_build_object(
    'sessionReference', guest_session_id, 'status', status, 'version', version,
    'brandReference', brand_id, 'storeReference', store_id,
    'publicStoreReference', public_store_id, 'publicTableReference', public_table_id,
    'channel', channel, 'locale', locale, 'qrReference', qr_id,
    'qrRevocationVersion', qr_revocation_version, 'diningState', dining_state,
    'diningSessionReference', dining_session_id, 'diningParticipantReference', dining_participant_id,
    'createdAt', to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lastSeenAt', to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'idleExpiresAt', to_char(idle_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'absoluteExpiresAt', to_char(absolute_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'orderClosedAt', to_char(order_closed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closureExpiresAt', to_char(closure_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'rotatedFromGuestSessionReference', rotated_from_guest_session_id,
    'revocationReason', revocation_reason,
    'revokedAt', to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ),
  'sessionSelectorHash', encode(session_selector_hash, 'hex'),
  'csrfSelectorHash', encode(csrf_selector_hash, 'hex'),
  'operationReference', operation_id, 'operationIntentHash', encode(operation_intent_hash, 'hex')
) AS record`;

const insert = `INSERT INTO bop_identity.guest_session (
  guest_session_id, session_selector_hash, csrf_selector_hash, operation_id, operation_intent_hash,
  brand_id, store_id, public_store_id, public_table_id, channel, locale, qr_id, qr_revocation_version,
  dining_state, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at, version
) VALUES ($1, decode($2, 'hex'), decode($3, 'hex'), $4, decode($5, 'hex'),
  $6, $7, $8, $9, $10, $11, $12, $13, 'ContextOnly', 'Active', $14, $14, $15, $16, 1)
ON CONFLICT DO NOTHING RETURNING ${projection}`;
const select = `SELECT ${projection} FROM bop_identity.guest_session
WHERE brand_id = $1 AND store_id = $2`;
const touch = `UPDATE bop_identity.guest_session
SET last_seen_at = $5, idle_expires_at = $6, version = version + 1
WHERE brand_id = $1 AND store_id = $2 AND session_selector_hash = decode($3, 'hex')
  AND version = $4 AND status = 'Active' AND last_seen_at <= $5
  AND idle_expires_at > $5 AND absolute_expires_at > $5
  AND (closure_expires_at IS NULL OR closure_expires_at > $5)
RETURNING ${projection}`;
const unavailable = () => new GuestSessionError("GUEST_SESSION_UNAVAILABLE");

export function createPostgresGuestSessionEntryStore(
  runner: GuestSessionEntryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
): GuestSessionEntryStore {
  const brand = parseOpaqueUuidV7(scope.brandReference, "IDENTITY_INPUT_INVALID");
  const store = parseOpaqueUuidV7(scope.storeReference, "IDENTITY_INPUT_INVALID");

  function record(result: unknown): GuestSessionRecord | null {
    if (typeof result !== "object" || result === null || !("rows" in result)) throw unavailable();
    const rows = result.rows;
    if (!Array.isArray(rows) || rows.length > 1) throw unavailable();
    if (rows.length === 0) return null;
    const row = rows[0] as { record?: unknown } | null;
    const parsed = createGuestSessionRecord(row?.record);
    if (parsed.session.brandReference !== brand || parsed.session.storeReference !== store)
      throw unavailable();
    return parsed;
  }

  async function run<T>(
    action: (transaction: GuestSessionEntryTransaction) => Promise<T>,
  ): Promise<T> {
    return runner.run(async (transaction) => {
      await transaction.query(
        "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
        [brand, store],
      );
      return action(transaction);
    });
  }

  return Object.freeze({
    async touchInteractive(command) {
      try {
        const selector = parseGuestSelectorHash(command.selectorHash);
        const observedAt = parseCanonicalInstant(command.observedAt);
        const idleExpiresAt = parseCanonicalInstant(command.idleExpiresAt);
        const version = command.expectedVersion;
        if (
          !Number.isInteger(version) ||
          version < 1 ||
          version >= 2_147_483_647 ||
          Date.parse(idleExpiresAt) !== Date.parse(observedAt) + 4 * 60 * 60 * 1000
        )
          throw unavailable();
        return await run(async (transaction) => {
          const persisted = record(
            await transaction.query(touch, [
              brand,
              store,
              selector,
              version,
              observedAt,
              idleExpiresAt,
            ]),
          );
          if (persisted !== null) {
            const session = assertGuestSessionUsable(persisted.session, observedAt);
            if (
              persisted.sessionSelectorHash !== selector ||
              session.version !== version + 1 ||
              session.lastSeenAt !== observedAt ||
              session.idleExpiresAt !== idleExpiresAt
            )
              throw unavailable();
          }
          return persisted;
        });
      } catch {
        throw unavailable();
      }
    },
    async create(command) {
      try {
        const input = createGuestSessionRecord(command.record);
        const session = input.session;
        if (
          session.brandReference !== brand ||
          session.storeReference !== store ||
          session.status !== "Active" ||
          session.version !== 1 ||
          session.diningState !== "ContextOnly" ||
          session.rotatedFromGuestSessionReference !== null ||
          session.orderClosedAt !== null ||
          session.lastSeenAt !== session.createdAt
        )
          throw unavailable();
        return await run(async (transaction) => {
          const persisted = record(
            await transaction.query(insert, [
              session.sessionReference,
              input.sessionSelectorHash,
              input.csrfSelectorHash,
              input.operationReference,
              input.operationIntentHash,
              brand,
              store,
              session.publicStoreReference,
              session.publicTableReference,
              session.channel,
              session.locale,
              session.qrReference,
              session.qrRevocationVersion,
              session.createdAt,
              session.idleExpiresAt,
              session.absoluteExpiresAt,
            ]),
          );
          // Never hand a concurrent attempt the credentials generated for a different insert.
          if (persisted === null || JSON.stringify(persisted) !== JSON.stringify(input))
            throw unavailable();
          return persisted;
        });
      } catch {
        throw unavailable();
      }
    },
    async resolve(selectorInput) {
      try {
        const selector = parseGuestSelectorHash(selectorInput);
        return await run(async (transaction) => {
          const found = record(
            await transaction.query(`${select} AND session_selector_hash = decode($3, 'hex')`, [
              brand,
              store,
              selector,
            ]),
          );
          if (found !== null && found.sessionSelectorHash !== selector) throw unavailable();
          return found;
        });
      } catch {
        throw unavailable();
      }
    },
    async resolveOperation(operationInput) {
      try {
        const operation = parseGuestOperationReference(operationInput);
        return await run(async (transaction) => {
          const found = record(
            await transaction.query(`${select} AND operation_id = $3`, [brand, store, operation]),
          );
          if (found !== null && found.operationReference !== operation) throw unavailable();
          return found;
        });
      } catch {
        throw unavailable();
      }
    },
  });
}
