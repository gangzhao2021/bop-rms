import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  OrderAcceptanceHoldError,
  parseOrderAcceptanceHold,
  resolveOrderAcceptanceDeadline,
  type OrderAcceptanceHold,
} from "../../application/order-acceptance-hold.js";
import { parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";

const unavailable = (): never => {
  throw new OrderAcceptanceHoldError("ORDER_ACCEPTANCE_HOLD_UNAVAILABLE");
};
const instant = (column: string) =>
  "to_char(" + column + " AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
const selectHolds =
  'SELECT h.hold_id::text "holdReference",h.brand_id::text "brandReference",h.store_id::text "storeReference",' +
  'h.order_id::text "orderReference",h.order_batch_id::text "orderBatchReference",' +
  'h.payment_event_id::text "paymentEventReference",h.hold_sequence "sequence",' +
  instant("h.lapsed_deadline") +
  ' "lapsedDeadline",' +
  "CASE WHEN h.store_last_seen_at IS NULL THEN NULL ELSE " +
  instant("h.store_last_seen_at") +
  ' END "storeLastSeenAt",' +
  instant("h.held_at") +
  ' "heldAt",' +
  "COALESCE((SELECT jsonb_agg(jsonb_build_object('resolution',r.resolution,'storeBackOnlineAt'," +
  "CASE WHEN r.store_back_online_at IS NULL THEN NULL ELSE " +
  instant("r.store_back_online_at") +
  " END,'decideBy'," +
  instant("r.decide_by") +
  ",'actorReference',r.actor_id::text,'recordedAt'," +
  instant("r.recorded_at") +
  ") ORDER BY r.resolution) FROM rms_ordering.order_acceptance_hold_resolution r " +
  "WHERE r.brand_id=h.brand_id AND r.store_id=h.store_id AND r.hold_id=h.hold_id),'[]'::jsonb) \"resolutions\" " +
  "FROM rms_ordering.order_acceptance_hold h ";

interface Scope {
  readonly brandReference: string;
  readonly storeReference: string;
}

async function setScope(tx: ConsumerTransaction, scope: Scope) {
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
}

function parseRows(rows: readonly unknown[], scope: Scope): OrderAcceptanceHold[] {
  return rows.map((row) => {
    const hold = parseOrderAcceptanceHold(row);
    if (
      hold.brandReference !== scope.brandReference ||
      hold.storeReference !== scope.storeReference
    )
      return unavailable();
    return hold;
  });
}

/**
 * WP-2423 Q9-G1: Ordering's append-only record of paid pickup orders held because the Store was
 * offline when their acceptance deadline passed, and how each hold ended (Store back online, or a
 * manager chose to refund). Writers serialize with acceptance and payment outcomes on the Order.
 */
export function createPostgresOrderAcceptanceHoldStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    tx: ConsumerTransaction,
    action: "ReadAcceptanceHold" | "RecordAcceptanceHold" | "ResolveAcceptanceHold",
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.brandReference)),
    storeReference: String(parseOrderingReference(options.storeReference)),
  });
  const allowed = async (
    tx: ConsumerTransaction,
    action: "ReadAcceptanceHold" | "RecordAcceptanceHold" | "ResolveAcceptanceHold",
  ) => {
    if ((await options.authorize(tx, action)) !== true) return unavailable();
  };
  const listBatch = async (tx: ConsumerTransaction, orderBatchReference: string) =>
    parseRows(
      (
        await tx.query(
          selectHolds +
            "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_batch_id=$3 ORDER BY h.hold_sequence",
          [scope.brandReference, scope.storeReference, orderBatchReference],
        )
      ).rows,
      scope,
    );
  const lockOrder = (tx: ConsumerTransaction, orderReference: string) =>
    tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingOrderDisposition:" +
        scope.brandReference +
        ":" +
        scope.storeReference +
        ":" +
        orderReference,
    ]);
  /** Whether the batch still has neither an acceptance nor a payment outcome. */
  const stillOpen = async (tx: ConsumerTransaction, order: string, batch: string) => {
    const found = await tx.query<{ open: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=$1 AND a.store_id=$2 AND a.order_id=$3 AND a.order_batch_id=$4) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=$1 AND d.store_id=$2 AND d.order_id=$3 AND d.order_batch_id=$4) AS open",
      [scope.brandReference, scope.storeReference, order, batch],
    );
    return found.rows[0]?.open === true;
  };
  const audited = async (
    tx: ConsumerTransaction,
    value: unknown,
    expected: { actionCode: string; targetId: string; occurredAt: string },
  ) => {
    const audit = validateAuditRecord(value);
    if (
      audit.brandId !== scope.brandReference ||
      audit.storeId !== scope.storeReference ||
      audit.actionCode !== expected.actionCode ||
      audit.targetType !== "OrderAcceptanceHold" ||
      audit.targetId !== expected.targetId ||
      audit.occurredAt !== expected.occurredAt
    )
      return unavailable();
    await appendAuditRecordInTransaction(tx, audit);
  };
  return Object.freeze({
    /** Every hold of one batch, oldest first. */
    async listByBatch(tx: ConsumerTransaction, orderBatchReference: string) {
      const batch = String(parseOrderingReference(orderBatchReference));
      await allowed(tx, "ReadAcceptanceHold");
      await setScope(tx, scope);
      const holds = await listBatch(tx, batch);
      await allowed(tx, "ReadAcceptanceHold");
      return Object.freeze(holds);
    },
    /**
     * Records the next hold of a batch. Returns "Closed" (nothing written) when the batch was
     * accepted or received its payment outcome meanwhile; an identical existing hold is returned.
     */
    async recordHold(
      tx: ConsumerTransaction,
      input: {
        holdReference: string;
        orderReference: string;
        orderBatchReference: string;
        paymentEventReference: string;
        sequence: number;
        lapsedDeadline: string;
        storeLastSeenAt: string | null;
        heldAt: string;
        audit(hold: OrderAcceptanceHold): Promise<unknown>;
      },
    ) {
      const candidate = parseOrderAcceptanceHold({
        holdReference: input.holdReference,
        ...scope,
        orderReference: input.orderReference,
        orderBatchReference: input.orderBatchReference,
        paymentEventReference: input.paymentEventReference,
        sequence: input.sequence,
        lapsedDeadline: input.lapsedDeadline,
        storeLastSeenAt: input.storeLastSeenAt,
        heldAt: input.heldAt,
        resolutions: [],
      });
      await allowed(tx, "RecordAcceptanceHold");
      await setScope(tx, scope);
      await lockOrder(tx, candidate.orderReference);
      const existing = (await listBatch(tx, candidate.orderBatchReference)).find(
        (hold) => hold.sequence === candidate.sequence,
      );
      if (existing !== undefined) {
        if (
          existing.lapsedDeadline !== candidate.lapsedDeadline ||
          existing.paymentEventReference !== candidate.paymentEventReference ||
          existing.orderReference !== candidate.orderReference
        )
          return unavailable();
        return Object.freeze({ status: "Existing" as const, hold: existing });
      }
      if (!(await stillOpen(tx, candidate.orderReference, candidate.orderBatchReference)))
        return Object.freeze({ status: "Closed" as const, hold: null });
      const inserted = await tx.query(
        "INSERT INTO rms_ordering.order_acceptance_hold (hold_id,brand_id,store_id,order_id,order_batch_id,payment_event_id,hold_sequence,lapsed_deadline,store_last_seen_at,held_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          candidate.holdReference,
          scope.brandReference,
          scope.storeReference,
          candidate.orderReference,
          candidate.orderBatchReference,
          candidate.paymentEventReference,
          candidate.sequence,
          candidate.lapsedDeadline,
          candidate.storeLastSeenAt,
          candidate.heldAt,
        ],
      );
      if (inserted.rowCount !== 1) return unavailable();
      await audited(tx, await input.audit(candidate), {
        actionCode: "ORDER_ACCEPTANCE_HELD_STORE_OFFLINE",
        targetId: candidate.holdReference,
        occurredAt: candidate.heldAt,
      });
      return Object.freeze({ status: "Created" as const, hold: candidate });
    },
    /**
     * Ends the batch's current hold: the Store came back online (deadline = back + 15 minutes), or a
     * manager chose to refund now. Returns "Closed" when the batch is no longer open.
     */
    async resolve(
      tx: ConsumerTransaction,
      input: {
        orderReference: string;
        orderBatchReference: string;
        holdReference: string;
        resolution: "StoreBackOnline" | "StaffRefund";
        storeBackOnlineAt: string | null;
        decideBy: string;
        actorReference: string | null;
        recordedAt: string;
        audit(hold: OrderAcceptanceHold): Promise<unknown>;
      },
    ) {
      const order = String(parseOrderingReference(input.orderReference));
      const batch = String(parseOrderingReference(input.orderBatchReference));
      const recordedAt = String(parseOrderingInstant(input.recordedAt));
      await allowed(tx, "ResolveAcceptanceHold");
      await setScope(tx, scope);
      await lockOrder(tx, order);
      const holds = await listBatch(tx, batch);
      const current = holds.at(-1);
      const first = holds[0];
      if (current === undefined || first === undefined || current.orderReference !== order)
        return unavailable();
      if (current.holdReference !== input.holdReference)
        return Object.freeze({ status: "Stale" as const, hold: current });
      const same = current.resolutions.find((entry) => entry.resolution === input.resolution);
      if (same !== undefined) return Object.freeze({ status: "Existing" as const, hold: current });
      if (!(await stillOpen(tx, order, batch)))
        return Object.freeze({ status: "Closed" as const, hold: null });
      const resolved = parseOrderAcceptanceHold({
        ...current,
        resolutions: [
          ...current.resolutions,
          {
            resolution: input.resolution,
            storeBackOnlineAt: input.storeBackOnlineAt,
            decideBy: input.decideBy,
            actorReference: input.actorReference,
            recordedAt,
          },
        ],
      });
      // The chain must stay well formed (validated against the batch's own history).
      resolveOrderAcceptanceDeadline({
        capacityExpiresAt: first.lapsedDeadline,
        holds: holds.map((hold) =>
          hold.holdReference === resolved.holdReference ? resolved : hold,
        ),
      });
      const added = resolved.resolutions.at(-1);
      if (added === undefined) return unavailable();
      const inserted = await tx.query(
        "INSERT INTO rms_ordering.order_acceptance_hold_resolution (brand_id,store_id,hold_id,resolution,store_back_online_at,decide_by,actor_id,recorded_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [
          scope.brandReference,
          scope.storeReference,
          resolved.holdReference,
          added.resolution,
          added.storeBackOnlineAt,
          added.decideBy,
          added.actorReference,
          added.recordedAt,
        ],
      );
      if (inserted.rowCount !== 1) return unavailable();
      await audited(tx, await input.audit(resolved), {
        actionCode:
          added.resolution === "StaffRefund"
            ? "ORDER_ACCEPTANCE_HOLD_REFUND_CHOSEN"
            : "ORDER_ACCEPTANCE_HOLD_STORE_BACK_ONLINE",
        targetId: resolved.holdReference,
        occurredAt: added.recordedAt,
      });
      return Object.freeze({ status: "Created" as const, hold: resolved });
    },
  });
}

/**
 * WP-2423 Q9-G1: the latest hold of each listed Order that is still open (no acceptance and no
 * payment outcome for its batch), for the merchant Orders page and the customer's order page.
 * Caller authorizes and owns the transaction.
 */
export async function listStoreOrderAcceptanceHolds(
  transaction: ConsumerTransaction,
  scope: Scope,
  orderReferences: readonly string[],
): Promise<ReadonlyMap<string, OrderAcceptanceHold>> {
  if (orderReferences.length === 0) return new Map();
  if (orderReferences.length > 100) return unavailable();
  const orders = orderReferences.map((reference) => String(parseOrderingReference(reference)));
  const owner = {
    brandReference: String(parseOrderingReference(scope.brandReference)),
    storeReference: String(parseOrderingReference(scope.storeReference)),
  };
  await setScope(transaction, owner);
  const rows = (
    await transaction.query(
      selectHolds +
        "WHERE h.brand_id=$1 AND h.store_id=$2 AND h.order_id=ANY($3::uuid[]) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_hold later WHERE later.brand_id=h.brand_id AND later.store_id=h.store_id AND later.order_batch_id=h.order_batch_id AND later.hold_sequence>h.hold_sequence) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_acceptance_record a WHERE a.brand_id=h.brand_id AND a.store_id=h.store_id AND a.order_id=h.order_id AND a.order_batch_id=h.order_batch_id) " +
        "AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=h.brand_id AND d.store_id=h.store_id AND d.order_id=h.order_id AND d.order_batch_id=h.order_batch_id) " +
        "ORDER BY h.order_id",
      [owner.brandReference, owner.storeReference, orders],
    )
  ).rows;
  const holds = parseRows(rows, owner);
  if (new Set(holds.map((hold) => hold.orderReference)).size !== holds.length) return unavailable();
  return new Map(holds.map((hold) => [hold.orderReference, hold]));
}
