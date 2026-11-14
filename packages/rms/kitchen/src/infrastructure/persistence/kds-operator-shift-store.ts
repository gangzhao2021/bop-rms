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
     * operator at this Store that has not been handed over yet: one who released the board, or
     * (with `sessionEnds`) one whose session ended without Release. Repeats are idempotent. */
    async start(input: {
      readonly transaction: ConsumerTransaction;
      readonly session: KdsOperatorSessionEvidence;
      readonly recordedAt: string;
      /** When each given earlier operator session ended (signed out, revoked or expired), or null
       * while it is still live; supplied by the composition from Identity. Without it, only an
       * explicit Release ends a shift. */
      readonly sessionEnds?: (
        sessionReferences: readonly string[],
      ) => Promise<ReadonlyMap<string, string | null>>;
    }): Promise<KdsOperatorHandoverRecord | null> {
      const tx = input.transaction,
        next = bound(input.session);
      if (next.state !== "Active") return unavailable();
      await scoped(tx);
      await append(tx, next, "Started", next.observedAt, input.recordedAt);
      const released = (
        await tx.query<Record<string, unknown>>(
          "SELECT r.session_id,r.actor_id,r.session_version,r.occurred_at AS ended_at," +
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
        )
      ).rows;
      // An operator who walked away without Release still ended their shift when their session
      // ended. Only sessions started within the absolute session lifetime can end that late.
      const unreleased =
        input.sessionEnds === undefined
          ? []
          : (
              await tx.query<Record<string, unknown>>(
                "SELECT s.session_id,s.actor_id,s.session_version,s.session_valid_until," +
                  "s.occurred_at AS started_at FROM rms_kitchen.kds_operator_shift_event s " +
                  "WHERE s.brand_id=$1 AND s.store_id=$2 AND s.event_kind='Started' " +
                  "AND s.session_id<>$3 AND s.actor_id<>$4 AND s.occurred_at<=$5 " +
                  "AND s.occurred_at>$5::timestamptz-interval '24 hours' " +
                  "AND NOT EXISTS (SELECT 1 FROM rms_kitchen.kds_operator_shift_event r WHERE " +
                  "r.brand_id=s.brand_id AND r.store_id=s.store_id AND r.session_id=s.session_id " +
                  "AND r.event_kind='Released') " +
                  "AND NOT EXISTS (SELECT 1 FROM rms_kitchen.kds_operator_handover h WHERE " +
                  "h.brand_id=s.brand_id AND h.store_id=s.store_id AND " +
                  "(h.prior_session_id=s.session_id OR h.next_session_id=$3)) " +
                  "ORDER BY s.occurred_at DESC,s.session_id DESC LIMIT 50",
                [brand, store, next.sessionReference, next.actorReference, next.observedAt],
              )
            ).rows;
      const ends =
        unreleased.length === 0 || input.sessionEnds === undefined
          ? new Map<string, string | null>()
          : await input.sessionEnds(unreleased.map((row) => String(row.session_id)));
      const candidates = [
        ...released.map((row) => ({ row, endedAt: iso(row.ended_at) })),
        ...unreleased.flatMap((row) => {
          const ended = ends.get(String(row.session_id));
          if (ended === undefined || ended === null) return [];
          const endedAt = parseKitchenTicketInstant(ended);
          return endedAt < iso(row.started_at) || endedAt > next.observedAt
            ? []
            : [{ row, endedAt }];
        }),
      ].sort((a, b) =>
        a.endedAt === b.endedAt
          ? String(b.row.session_id).localeCompare(String(a.row.session_id))
          : a.endedAt < b.endedAt
            ? 1
            : -1,
      );
      const latest = candidates[0];
      if (!latest) return null;
      const row = latest.row;
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
        priorFinalizedAt: latest.endedAt,
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
