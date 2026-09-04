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

export type GuestSessionEntryStore = GuestSessionStorePort;
export type GuestSessionLegacyClassification =
  "NoLegacyRows" | "InactiveLegacyRowsOnly" | "LiveLegacyRowsPresent";

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
const historySelect = `SELECT ${projection} FROM bop_identity.guest_session_operation
WHERE brand_id = $1 AND store_id = $2 AND operation_id = $3`;
const columns = `guest_session_id, session_selector_hash, csrf_selector_hash, operation_id,
operation_intent_hash, brand_id, store_id, public_store_id, public_table_id, channel, locale,
qr_id, qr_revocation_version, dining_state, status, created_at, last_seen_at, idle_expires_at,
absolute_expires_at, order_closed_at, closure_expires_at, rotated_from_guest_session_id,
revocation_reason, revoked_at, version, dining_session_id, dining_participant_id`;
const snapshot = `INSERT INTO bop_identity.guest_session_operation (${columns})
SELECT guest_session_id, session_selector_hash, csrf_selector_hash, $4, decode($5, 'hex'),
brand_id, store_id, public_store_id, public_table_id, channel, locale, qr_id, qr_revocation_version,
dining_state, status, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
order_closed_at, closure_expires_at, rotated_from_guest_session_id, revocation_reason, revoked_at,
version, dining_session_id, dining_participant_id
FROM bop_identity.guest_session WHERE brand_id = $1 AND store_id = $2 AND guest_session_id = $3
ON CONFLICT DO NOTHING RETURNING ${projection}`;
const retire = `UPDATE bop_identity.guest_session
SET status = 'Revoked', revocation_reason = $5, revoked_at = $6, version = version + 1
WHERE brand_id = $1 AND store_id = $2 AND session_selector_hash = decode($3, 'hex')
AND version = $4 AND status = 'Active' RETURNING ${projection}`;
const rotatedInsert = `INSERT INTO bop_identity.guest_session (${columns})
VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,$9,$10,$11,$12,$13,
$14,'Active',$15,$15,$16,$17,NULL,NULL,$18,NULL,NULL,1,$19,$20)
ON CONFLICT DO NOTHING RETURNING ${projection}`;
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

  async function append(transaction: GuestSessionEntryTransaction, input: GuestSessionRecord) {
    const saved = record(
      await transaction.query(snapshot, [
        brand,
        store,
        input.session.sessionReference,
        input.operationReference,
        input.operationIntentHash,
      ]),
    );
    if (saved === null || JSON.stringify(saved) !== JSON.stringify(input)) throw unavailable();
  }

  async function lockCurrent(
    transaction: GuestSessionEntryTransaction,
    selector: string,
    version: number,
    observedAt: string,
  ) {
    if (!Number.isInteger(version) || version < 1 || version >= 2_147_483_647) throw unavailable();
    const current = record(
      await transaction.query(
        `${select} AND session_selector_hash = decode($3, 'hex') FOR UPDATE`,
        [brand, store, selector],
      ),
    );
    if (
      current === null ||
      current.sessionSelectorHash !== selector ||
      current.session.status !== "Active"
    )
      throw unavailable();
    if (current.session.version !== version)
      throw new GuestSessionError("GUEST_SESSION_VERSION_CONFLICT");
    if (Date.parse(observedAt) < Date.parse(current.session.lastSeenAt)) throw unavailable();
    const original = record(
      await transaction.query(historySelect, [brand, store, current.operationReference]),
    );
    if (
      original === null ||
      original.operationReference !== current.operationReference ||
      original.session.sessionReference !== current.session.sessionReference ||
      original.operationIntentHash !== current.operationIntentHash
    )
      throw unavailable();
    return current;
  }

  async function terminate(
    transaction: GuestSessionEntryTransaction,
    current: GuestSessionRecord,
    reason: string,
    observedAt: string,
  ) {
    const expected = createGuestSessionRecord({
      ...current,
      session: {
        ...current.session,
        status: "Revoked",
        version: current.session.version + 1,
        revocationReason: reason,
        revokedAt: observedAt,
      },
    });
    const saved = record(
      await transaction.query(retire, [
        brand,
        store,
        current.sessionSelectorHash,
        current.session.version,
        reason,
        observedAt,
      ]),
    );
    if (saved === null || JSON.stringify(saved) !== JSON.stringify(expected)) throw unavailable();
    return saved;
  }

  function lifecycleError(error: unknown): never {
    if (error instanceof GuestSessionError && error.code === "GUEST_SESSION_VERSION_CONFLICT")
      throw new GuestSessionError("GUEST_SESSION_VERSION_CONFLICT");
    throw unavailable();
  }

  return Object.freeze<GuestSessionEntryStore>({
    async rotate(command) {
      try {
        const selector = parseGuestSelectorHash(command.currentSelectorHash);
        const observedAt = parseCanonicalInstant(command.observedAt);
        const next = createGuestSessionRecord(command.nextRecord);
        const s = next.session;
        if (
          !["Rotated", "BindingChanged", "RiskChanged"].includes(command.reason) ||
          s.brandReference !== brand ||
          s.storeReference !== store ||
          s.status !== "Active" ||
          s.version !== 1 ||
          s.createdAt !== observedAt ||
          s.lastSeenAt !== observedAt ||
          s.orderClosedAt !== null
        )
          throw unavailable();
        return await run(async (transaction) => {
          const current = await lockCurrent(
            transaction,
            selector,
            command.expectedVersion,
            observedAt,
          );
          const old = assertGuestSessionUsable(current.session, observedAt);
          if (
            s.rotatedFromGuestSessionReference !== old.sessionReference ||
            s.sessionReference === old.sessionReference ||
            next.sessionSelectorHash === selector ||
            next.csrfSelectorHash === current.csrfSelectorHash
          )
            throw unavailable();
          if (
            s.diningState === "DiningBound" &&
            (command.reason !== "BindingChanged" ||
              old.diningState !== "ContextOnly" ||
              s.channel !== old.channel ||
              s.locale !== old.locale ||
              s.publicStoreReference !== old.publicStoreReference ||
              s.publicTableReference !== old.publicTableReference ||
              s.qrReference !== old.qrReference ||
              s.qrRevocationVersion !== old.qrRevocationVersion)
          )
            throw unavailable();
          await terminate(transaction, current, command.reason, observedAt);
          const saved = record(
            await transaction.query(rotatedInsert, [
              s.sessionReference,
              next.sessionSelectorHash,
              next.csrfSelectorHash,
              next.operationReference,
              next.operationIntentHash,
              brand,
              store,
              s.publicStoreReference,
              s.publicTableReference,
              s.channel,
              s.locale,
              s.qrReference,
              s.qrRevocationVersion,
              s.diningState,
              observedAt,
              s.idleExpiresAt,
              s.absoluteExpiresAt,
              s.rotatedFromGuestSessionReference,
              s.diningSessionReference,
              s.diningParticipantReference,
            ]),
          );
          if (saved === null || JSON.stringify(saved) !== JSON.stringify(next)) throw unavailable();
          await append(transaction, saved);
          return saved;
        });
      } catch (error) {
        return lifecycleError(error);
      }
    },
    async revoke(command) {
      try {
        const selector = parseGuestSelectorHash(command.selectorHash);
        const observedAt = parseCanonicalInstant(command.observedAt);
        const operation = parseGuestOperationReference(command.operationReference);
        const intent = parseGuestSelectorHash(command.operationIntentHash);
        return await run(async (transaction) => {
          const current = await lockCurrent(
            transaction,
            selector,
            command.expectedVersion,
            observedAt,
          );
          const saved = await terminate(transaction, current, command.reason, observedAt);
          await append(
            transaction,
            createGuestSessionRecord({
              ...saved,
              operationReference: operation,
              operationIntentHash: intent,
            }),
          );
          return saved.session;
        });
      } catch (error) {
        return lifecycleError(error);
      }
    },
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
          await append(transaction, persisted);
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
          const found =
            record(await transaction.query(historySelect, [brand, store, operation])) ??
            record(
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

export function createPostgresGuestSessionLegacyInspector(
  runner: GuestSessionEntryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const brand = parseOpaqueUuidV7(scope.brandReference, "IDENTITY_INPUT_INVALID");
  const store = parseOpaqueUuidV7(scope.storeReference, "IDENTITY_INPUT_INVALID");
  return Object.freeze({
    async inspect(observedAtInput: unknown): Promise<
      Readonly<{
        classification: GuestSessionLegacyClassification;
        observedAt: string;
      }>
    > {
      try {
        const observedAt = parseCanonicalInstant(observedAtInput);
        const result = await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          return transaction.query(
            `WITH legacy AS (
            SELECT s.status, s.idle_expires_at, s.absolute_expires_at, s.closure_expires_at
            FROM bop_identity.guest_session AS s
            WHERE s.brand_id = $1 AND s.store_id = $2 AND NOT EXISTS (
              SELECT 1 FROM bop_identity.guest_session_operation AS h
              WHERE h.brand_id = s.brand_id AND h.store_id = s.store_id
                AND h.guest_session_id = s.guest_session_id AND h.operation_id = s.operation_id
                AND h.operation_intent_hash = s.operation_intent_hash)
          ) SELECT EXISTS (SELECT 1 FROM legacy) AS "hasLegacy",
            EXISTS (SELECT 1 FROM legacy WHERE status = 'Active' AND idle_expires_at > $3
              AND absolute_expires_at > $3
              AND (closure_expires_at IS NULL OR closure_expires_at > $3)) AS "hasLiveLegacy"`,
            [brand, store, observedAt],
          );
        });
        if (
          typeof result !== "object" ||
          result === null ||
          !("rows" in result) ||
          !Array.isArray(result.rows) ||
          result.rows.length !== 1
        )
          throw unavailable();
        const row = result.rows[0];
        if (
          typeof row !== "object" ||
          row === null ||
          typeof row.hasLegacy !== "boolean" ||
          typeof row.hasLiveLegacy !== "boolean" ||
          (row.hasLiveLegacy && !row.hasLegacy)
        )
          throw unavailable();
        return Object.freeze({
          observedAt,
          classification: row.hasLiveLegacy
            ? "LiveLegacyRowsPresent"
            : row.hasLegacy
              ? "InactiveLegacyRowsOnly"
              : "NoLegacyRows",
        });
      } catch {
        throw unavailable();
      }
    },
  });
}
