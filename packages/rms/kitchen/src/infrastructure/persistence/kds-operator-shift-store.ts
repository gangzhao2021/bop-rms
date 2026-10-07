import type { ConsumerTransaction } from "@bop/eventing";
import {
  createKdsOperatorHandover,
  KdsContinuityError,
  parseKdsOperatorSessionEvidence,
  type KdsOperatorHandoverRecord,
  type KdsOperatorSessionEvidence,
} from "../../domain/kds-continuity.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../../domain/kitchen-ticket.js";

const unavailable = (): never => {
  throw new KdsContinuityError("KDS_OPERATOR_SESSION_UNAVAILABLE");
};
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : parseKitchenTicketInstant(value);

/** WP-2423 / IDR-0039: Kitchen-owned Start and Release facts for named KDS Operator Sessions at
 * one Store, and the handover Kitchen derives from them. Identity Sessions are never read here. */
export function createPostgresKdsOperatorShiftStore(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly references: { readonly next: () => string };
}) {
  const brand = parseKitchenTicketReference(options.brandReference);
  const store = parseKitchenTicketReference(options.storeReference);
  async function scoped(tx: ConsumerTransaction) {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "KdsOperatorShift:" + brand + ":" + store,
    ]);
  }
  function bound(session: KdsOperatorSessionEvidence) {
    const evidence = parseKdsOperatorSessionEvidence(session);
    if (evidence.brandReference !== brand || evidence.storeReference !== store)
      return unavailable();
    return evidence;
  }
  async function append(
    tx: ConsumerTransaction,
    session: KdsOperatorSessionEvidence,
    eventKind: "Started" | "Released",
    occurredAt: string,
    recordedAt: string,
  ) {
    await tx.query(
      "INSERT INTO rms_kitchen.kds_operator_shift_event(" +
        "kds_operator_shift_event_id,brand_id,store_id,session_id,actor_id,session_version," +
        "event_kind,occurred_at,session_valid_until,recorded_at,data_classification) " +
        "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Personal') " +
        "ON CONFLICT (brand_id,store_id,session_id,event_kind) DO NOTHING",
      [
        parseKitchenTicketReference(options.references.next()),
        brand,
        store,
        session.sessionReference,
        session.actorReference,
        session.sessionVersion,
        eventKind,
        parseKitchenTicketInstant(occurredAt),
        session.validUntil,
        parseKitchenTicketInstant(recordedAt),
      ],
    );
  }
  return Object.freeze({
    /** Records the Start once and derives a ShiftHandover from the latest released prior
     * operator at this Store that has not been handed over yet. Repeats are idempotent. */
    async start(input: {
      readonly transaction: ConsumerTransaction;
      readonly session: KdsOperatorSessionEvidence;
      readonly recordedAt: string;
    }): Promise<KdsOperatorHandoverRecord | null> {
      const tx = input.transaction,
        next = bound(input.session);
      if (next.state !== "Active") return unavailable();
      await scoped(tx);
      await append(tx, next, "Started", next.observedAt, input.recordedAt);
      const prior = await tx.query<Record<string, unknown>>(
        "SELECT r.session_id,r.actor_id,r.session_version,r.occurred_at AS released_at," +
          "r.session_valid_until,s.occurred_at AS started_at " +
          "FROM rms_kitchen.kds_operator_shift_event r " +
          "JOIN rms_kitchen.kds_operator_shift_event s ON s.brand_id=r.brand_id AND " +
          "s.store_id=r.store_id AND s.session_id=r.session_id AND s.event_kind='Started' " +
          "WHERE r.brand_id=$1 AND r.store_id=$2 AND r.event_kind='Released' " +
          "AND r.session_id<>$3 AND r.actor_id<>$4 AND r.occurred_at<=$5 " +
          "AND NOT EXISTS (SELECT 1 FROM rms_kitchen.kds_operator_handover h WHERE " +
          "h.brand_id=r.brand_id AND h.store_id=r.store_id AND " +
          "(h.prior_session_id=r.session_id OR h.next_session_id=$3)) " +
          "ORDER BY r.occurred_at DESC,r.session_id DESC LIMIT 1",
        [brand, store, next.sessionReference, next.actorReference, next.observedAt],
      );
      const row = prior.rows[0];
      if (!row) return null;
      const record = createKdsOperatorHandover({
        handoverReference: options.references.next(),
        priorSession: {
          sessionReference: String(row.session_id),
          actorReference: String(row.actor_id),
          brandReference: brand,
          storeReference: store,
          sessionVersion: Number(row.session_version),
          sessionKind: "NamedKdsOperator",
          state: "Ended",
          observedAt: iso(row.started_at),
          validUntil: iso(row.session_valid_until),
        } as unknown as KdsOperatorSessionEvidence,
        nextSession: next,
        priorFinalizedAt: iso(row.released_at),
        nextActivatedAt: next.observedAt,
        recordedAt: parseKitchenTicketInstant(input.recordedAt),
        reasonCode: "ShiftHandover",
      });
      await tx.query(
        "INSERT INTO rms_kitchen.kds_operator_handover(" +
          "kds_operator_handover_id,brand_id,store_id,prior_session_id,prior_actor_id," +
          "prior_final_state,prior_finalized_at,next_session_id,next_actor_id,next_activated_at," +
          "recorded_at,reason_code,data_classification) " +
          "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Personal') ON CONFLICT DO NOTHING",
        [
          record.handoverReference,
          record.brandReference,
          record.storeReference,
          record.priorSessionReference,
          record.priorActorReference,
          record.priorFinalState,
          record.priorFinalizedAt,
          record.nextSessionReference,
          record.nextActorReference,
          record.nextActivatedAt,
          record.recordedAt,
          record.reasonCode,
        ],
      );
      return record;
    },
    /** Records that this named operator released the board before signing out. */
    async release(input: {
      readonly transaction: ConsumerTransaction;
      readonly session: KdsOperatorSessionEvidence;
      readonly releasedAt: string;
    }): Promise<void> {
      const session = bound(input.session);
      if (session.state !== "Active") return unavailable();
      await scoped(input.transaction);
      await append(input.transaction, session, "Released", input.releasedAt, input.releasedAt);
    },
  });
}
