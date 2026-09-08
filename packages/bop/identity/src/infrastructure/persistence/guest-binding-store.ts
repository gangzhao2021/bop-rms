import {
  acknowledgeGuestBinding,
  activateGuestBinding,
  completeGuestBinding,
  parseGuestBindingPreparation,
  type GuestBindingPreparation,
  type GuestBindingProof,
  type GuestBindingOwnerEvidence,
  type GuestBindingHashEquals,
} from "../../contracts/guest-binding-preparation.js";
import {
  assertGuestSessionUsable,
  GuestSessionError,
  parseGuestOperationReference,
  parseGuestSelectorHash,
  type GuestSelectorHash,
} from "../../contracts/guest-session.js";
import {
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  type CanonicalInstant,
} from "../../contracts/identity-actor.js";
import {
  createPostgresGuestSessionEntryStore,
  type GuestSessionEntryTransaction,
  type GuestSessionEntryTransactionRunner,
} from "./guest-session-entry-store.js";

export interface GuestBindingAuditDescriptor {
  readonly action: "Prepared" | "Acknowledged" | "Activated";
  readonly operationReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly occurredAt: CanonicalInstant;
}
export interface GuestBindingAuditPort {
  /** Must append through Audit's public contract in this exact transaction, never an external call. */
  append(
    transaction: GuestSessionEntryTransaction,
    descriptor: GuestBindingAuditDescriptor,
  ): Promise<void>;
}

function unavailable(): never {
  throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
}
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("rows" in value) ||
    !Array.isArray(value.rows) ||
    value.rows.some((row) => typeof row !== "object" || row === null || Array.isArray(row))
  )
    return unavailable();
  return value.rows;
}

export function createPostgresGuestBindingStore(
  runner: GuestSessionEntryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
  audit: GuestBindingAuditPort,
  equals: GuestBindingHashEquals,
) {
  const brand = parseOpaqueUuidV7(scope.brandReference, "IDENTITY_INPUT_INVALID");
  const store = parseOpaqueUuidV7(scope.storeReference, "IDENTITY_INPUT_INVALID");
  if (typeof audit?.append !== "function" || typeof equals !== "function") unavailable();
  const scoped = (value: unknown) => {
    const record = parseGuestBindingPreparation(value);
    if (
      record.predecessor.session.brandReference !== brand ||
      record.predecessor.session.storeReference !== store
    )
      unavailable();
    return record;
  };
  async function run<T>(action: (tx: GuestSessionEntryTransaction) => Promise<T>): Promise<T> {
    try {
      return await runner.run(async (tx) => {
        await tx.query(
          "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
          [brand, store],
        );
        return action(tx);
      });
    } catch {
      return unavailable();
    }
  }
  const sessions = (tx: GuestSessionEntryTransaction) =>
    createPostgresGuestSessionEntryStore({ run: (action) => action(tx) }, scope);
  async function current(
    tx: GuestSessionEntryTransaction,
    selector: GuestSelectorHash,
    at: CanonicalInstant,
    lock: boolean,
  ) {
    if (lock) {
      const locked = rows(
        await tx.query(
          `SELECT guest_session_id FROM bop_identity.guest_session
        WHERE brand_id=$1 AND store_id=$2 AND session_selector_hash=decode($3,'hex') FOR UPDATE`,
          [brand, store, selector],
        ),
      );
      if (locked.length !== 1) return unavailable();
    }
    const value = await sessions(tx).resolve(selector);
    if (value === null) return unavailable();
    assertGuestSessionUsable(value.session, at);
    return value;
  }
  async function load(tx: GuestSessionEntryTransaction, operation: string) {
    const result = rows(
      await tx.query(
        `SELECT record FROM bop_identity.guest_binding_preparation
      WHERE brand_id=$1 AND store_id=$2 AND operation_id=$3 ORDER BY revision DESC LIMIT 1`,
        [brand, store, operation],
      ),
    );
    if (result.length > 1) return unavailable();
    if (result.length === 0) return null;
    const record = scoped(result[0]?.record);
    if (record.operationReference !== operation) return unavailable();
    return record;
  }
  async function append(
    tx: GuestSessionEntryTransaction,
    record: GuestBindingPreparation,
    at: CanonicalInstant,
  ) {
    const result = rows(
      await tx.query(
        `INSERT INTO bop_identity.guest_binding_preparation
      (operation_id,revision,brand_id,store_id,predecessor_id,candidate_id,target_id,status,record)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING record`,
        [
          record.operationReference,
          record.revision,
          brand,
          store,
          record.predecessor.session.sessionReference,
          record.candidate.session.sessionReference,
          record.targetReference,
          record.status,
          JSON.stringify(record),
        ],
      ),
    );
    if (result.length !== 1 || JSON.stringify(scoped(result[0]?.record)) !== JSON.stringify(record))
      return unavailable();
    await audit.append(
      tx,
      Object.freeze({
        action: record.status,
        operationReference: record.operationReference,
        brandReference: brand,
        storeReference: store,
        occurredAt: at,
      }),
    );
    return record;
  }
  return Object.freeze({
    async prepare(value: GuestBindingPreparation, observedAt: CanonicalInstant) {
      const record = scoped(value);
      const at = parseCanonicalInstant(observedAt);
      if (record.status !== "Prepared" || at < record.preparedAt || at >= record.expiresAt)
        return unavailable();
      return run(async (tx) => {
        const predecessor = await current(tx, record.predecessor.sessionSelectorHash, at, true);
        if (JSON.stringify(predecessor) !== JSON.stringify(record.predecessor))
          return unavailable();
        const prior = await load(tx, record.operationReference);
        if (prior !== null) {
          if (JSON.stringify(prior) !== JSON.stringify(record)) return unavailable();
          return prior;
        }
        return append(tx, record, at);
      });
    },
    async acknowledge(input: {
      readonly operationReference: string;
      readonly currentSelectorHash: GuestSelectorHash;
      readonly proof: GuestBindingProof;
      readonly observedAt: CanonicalInstant;
    }) {
      const operation = parseGuestOperationReference(input.operationReference);
      const selector = parseGuestSelectorHash(input.currentSelectorHash);
      const at = parseCanonicalInstant(input.observedAt);
      return run(async (tx) => {
        const predecessor = await current(tx, selector, at, true);
        const prior = await load(tx, operation);
        if (prior === null) return unavailable();
        const next = acknowledgeGuestBinding(
          { preparation: prior, current: predecessor, proof: input.proof, observedAt: at },
          equals,
        );
        return next.revision === prior.revision ? prior : append(tx, next, at);
      });
    },
    async activate(input: {
      readonly operationReference: string;
      readonly currentSelectorHash: GuestSelectorHash;
      readonly proof: GuestBindingProof;
      readonly ownerEvidence: GuestBindingOwnerEvidence;
      readonly observedAt: CanonicalInstant;
    }) {
      const operation = parseGuestOperationReference(input.operationReference);
      const selector = parseGuestSelectorHash(input.currentSelectorHash);
      const at = parseCanonicalInstant(input.observedAt);
      return run(async (tx) => {
        const predecessor = await current(tx, selector, at, true);
        const prior = await load(tx, operation);
        if (prior === null) return unavailable();
        const plan = activateGuestBinding(
          {
            preparation: prior,
            current: predecessor,
            proof: input.proof,
            ownerEvidence: input.ownerEvidence,
            observedAt: at,
          },
          equals,
        );
        const retired = rows(
          await tx.query(
            `UPDATE bop_identity.guest_session SET status='Revoked',
          revocation_reason='BindingChanged',revoked_at=$5,version=version+1
          WHERE brand_id=$1 AND store_id=$2 AND guest_session_id=$3 AND version=$4 AND status='Active'
          RETURNING guest_session_id`,
            [
              brand,
              store,
              predecessor.session.sessionReference,
              plan.expectedPredecessorVersion,
              at,
            ],
          ),
        );
        if (retired.length !== 1) return unavailable();
        const c = plan.candidate;
        const s = c.session;
        const inserted = rows(
          await tx.query(
            `INSERT INTO bop_identity.guest_session
          (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,
          brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,
          dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,rotated_from_guest_session_id)
          VALUES ($1,decode($2,'hex'),decode($3,'hex'),$4,decode($5,'hex'),$6,$7,$8,NULL,'Pickup',$9,$10,$11,
          'ContextOnly','Active',$12,$12,$13,$14,1,$15) RETURNING guest_session_id`,
            [
              s.sessionReference,
              c.sessionSelectorHash,
              c.csrfSelectorHash,
              c.operationReference,
              c.operationIntentHash,
              brand,
              store,
              s.publicStoreReference,
              s.locale,
              s.qrReference,
              s.qrRevocationVersion,
              s.createdAt,
              s.idleExpiresAt,
              s.absoluteExpiresAt,
              s.rotatedFromGuestSessionReference,
            ],
          ),
        );
        if (inserted.length !== 1) return unavailable();
        const saved = await sessions(tx).resolve(c.sessionSelectorHash);
        if (JSON.stringify(saved) !== JSON.stringify(c)) return unavailable();
        const history = rows(
          await tx.query(
            `INSERT INTO bop_identity.guest_session_operation (guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,order_closed_at,closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,dining_session_id,dining_participant_id)
          SELECT guest_session_id,session_selector_hash,csrf_selector_hash,operation_id,operation_intent_hash,brand_id,store_id,public_store_id,public_table_id,channel,locale,qr_id,qr_revocation_version,dining_state,status,created_at,last_seen_at,idle_expires_at,absolute_expires_at,version,order_closed_at,closure_expires_at,rotated_from_guest_session_id,revocation_reason,revoked_at,dining_session_id,dining_participant_id FROM bop_identity.guest_session WHERE brand_id=$1 AND store_id=$2 AND guest_session_id=$3
          RETURNING operation_id`,
            [brand, store, s.sessionReference],
          ),
        );
        if (history.length !== 1) return unavailable();
        return append(tx, plan.preparation, at);
      });
    },
    async complete(input: {
      readonly operationReference: string;
      readonly sessionSelectorHash: GuestSelectorHash;
      readonly csrfSelectorHash: GuestSelectorHash;
      readonly observedAt: CanonicalInstant;
    }) {
      const operation = parseGuestOperationReference(input.operationReference);
      const selector = parseGuestSelectorHash(input.sessionSelectorHash);
      const at = parseCanonicalInstant(input.observedAt);
      return run(async (tx) => {
        const candidate = await current(tx, selector, at, true);
        const preparation = await load(tx, operation);
        if (preparation === null) return unavailable();
        return completeGuestBinding(
          {
            preparation,
            current: candidate,
            sessionSelectorHash: selector,
            csrfSelectorHash: input.csrfSelectorHash,
            observedAt: at,
          },
          equals,
        );
      });
    },
  });
}
