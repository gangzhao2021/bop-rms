import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderingReference } from "../../domain/cart.js";
import {
  resolveOrderCanonicalPhase,
  type OrderKitchenProgressFact,
  type OrderKitchenProgressFactKind,
} from "../../domain/order-canonical-phase.js";
import type { OrderKitchenProgressEvent } from "../../application/kitchen-progress-event.js";

type Scope = Readonly<{ brandReference: string; storeReference: string }>;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

async function scoped(transaction: ConsumerTransaction, scope: Scope) {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  return { brand, store };
}

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: append a consumed Kitchen event's facts to Ordering's own
 * record. Ordering resolves the Order and Batch from its own items; a replay of the same event with
 * the same facts is a no-op and a different payload for a recorded event is refused.
 */
export function createPostgresOrderKitchenProgressFactStore(scope: Scope) {
  return Object.freeze({
    async record(transaction: ConsumerTransaction, event: OrderKitchenProgressEvent) {
      const { brand, store } = await scoped(transaction, scope);
      if (event.brandReference !== brand || event.storeReference !== store)
        throw new Error("ORDER_KITCHEN_PROGRESS_SCOPE_DENIED");
      const rows: {
        ordinal: number;
        order: string;
        batch: string;
        item: string | null;
        kind: OrderKitchenProgressFactKind;
        occurredAt: string;
      }[] = [];
      for (const [ordinal, fact] of event.facts.entries()) {
        let order: string, batch: string;
        if (fact.orderItemReference !== null) {
          const found = await transaction.query<{ order_id: string; order_batch_id: string }>(
            "SELECT order_id::text,order_batch_id::text FROM rms_ordering.order_item WHERE brand_id=$1 AND store_id=$2 AND order_item_id=$3",
            [brand, store, fact.orderItemReference],
          );
          const row = found.rows[0];
          if (!row) return false;
          order = row.order_id;
          batch = row.order_batch_id;
        } else {
          if (event.orderReference === null || fact.orderBatchReference === null)
            throw new Error("ORDER_KITCHEN_PROGRESS_INVALID");
          const found = await transaction.query(
            "SELECT 1 FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND order_batch_id=$4",
            [brand, store, event.orderReference, fact.orderBatchReference],
          );
          if (found.rows.length !== 1) return false;
          order = event.orderReference;
          batch = fact.orderBatchReference;
        }
        if (
          (event.orderReference !== null && event.orderReference !== order) ||
          (fact.orderBatchReference !== null && fact.orderBatchReference !== batch)
        )
          throw new Error("ORDER_KITCHEN_PROGRESS_INVALID");
        rows.push({
          ordinal,
          order,
          batch,
          item: fact.orderItemReference,
          kind: fact.kind,
          occurredAt: fact.occurredAt,
        });
      }
      const existing = await transaction.query<{
        fact_ordinal: number;
        order_id: string;
        order_batch_id: string;
        order_item_id: string | null;
        fact_kind: string;
        source_event_type: string;
        occurred_at: Date | string;
      }>(
        "SELECT fact_ordinal,order_id::text,order_batch_id::text,order_item_id::text,fact_kind,source_event_type,occurred_at FROM rms_ordering.order_kitchen_progress_fact WHERE source_event_id=$1 AND brand_id=$2 AND store_id=$3 ORDER BY fact_ordinal",
        [event.eventId, brand, store],
      );
      if (existing.rows.length > 0) {
        const same =
          existing.rows.length === rows.length &&
          existing.rows.every((row, index) => {
            const expected = rows[index];
            return (
              expected !== undefined &&
              row.fact_ordinal === expected.ordinal &&
              row.order_id === expected.order &&
              row.order_batch_id === expected.batch &&
              row.order_item_id === expected.item &&
              row.fact_kind === expected.kind &&
              row.source_event_type === event.eventType &&
              iso(row.occurred_at) === expected.occurredAt
            );
          });
        if (!same) throw new Error("ORDER_KITCHEN_PROGRESS_CONFLICT");
        return true;
      }
      for (const row of rows) {
        const inserted = await transaction.query(
          "INSERT INTO rms_ordering.order_kitchen_progress_fact (source_event_id,fact_ordinal,brand_id,store_id,order_id,order_batch_id,order_item_id,source_event_type,fact_kind,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            event.eventId,
            row.ordinal,
            brand,
            store,
            row.order,
            row.batch,
            row.item,
            event.eventType,
            row.kind,
            row.occurredAt,
          ],
        );
        if (inserted.rowCount !== 1) throw new Error("ORDER_KITCHEN_PROGRESS_NOT_RECORDED");
      }
      return true;
    },
  });
}

const uuidList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map((entry) => parseOrderingReference(String(entry)));
  if (typeof value === "string" && /^\{.*\}$/u.test(value))
    return value
      .slice(1, -1)
      .split(",")
      .filter((entry) => entry.length > 0)
      .map((entry) => parseOrderingReference(entry));
  throw new Error("ORDER_CANONICAL_PHASE_UNAVAILABLE");
};

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: the Order's current overall phase, merged by Ordering from
 * its own append-only records (items, acceptance, cancellations, termination, pickup completion)
 * and the Kitchen facts in its inbox record. Read under the caller's transaction and scope; returns
 * null when the Order is not visible in this Store.
 */
export async function loadOrderCanonicalPhase(
  transaction: ConsumerTransaction,
  scope: Scope,
  orderReferenceValue: string,
) {
  const { brand, store } = await scoped(transaction, scope);
  const order = parseOrderingReference(orderReferenceValue);
  const values = [brand, store, order];
  const where = "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3";
  const items = await transaction.query<{ order_item_id: string; order_batch_id: string }>(
    "SELECT order_item_id::text,order_batch_id::text FROM rms_ordering.order_item " +
      where +
      " LIMIT 10001",
    values,
  );
  if (items.rows.length === 0) return null;
  if (items.rows.length > 10000) throw new Error("ORDER_CANONICAL_PHASE_UNAVAILABLE");
  const accepted = await transaction.query<{ order_batch_id: string }>(
    "SELECT order_batch_id::text FROM rms_ordering.order_acceptance_record " + where,
    values,
  );
  const checkoutCancelled = await transaction.query<{ order_batch_id: string }>(
    "SELECT order_batch_id::text FROM rms_ordering.order_batch_checkout_cancellation " + where,
    values,
  );
  const staffCancelled = await transaction.query<{ order_batch_id: string }>(
    "SELECT order_batch_id::text FROM rms_ordering.order_staff_cancellation " + where,
    values,
  );
  const itemsCancelled = await transaction.query<{ order_item_ids: unknown }>(
    "SELECT order_item_ids::text[] AS order_item_ids FROM rms_ordering.order_item_staff_cancellation " +
      where,
    values,
  );
  const termination = await transaction.query<{ phase: string }>(
    "SELECT phase FROM rms_ordering.order_termination_record " + where,
    values,
  );
  const fulfilled = await transaction.query(
    "SELECT 1 FROM rms_ordering.order_fulfillment_completion_record " + where + " LIMIT 1",
    values,
  );
  const kitchen = await transaction.query<{
    order_batch_id: string;
    order_item_id: string | null;
    fact_kind: OrderKitchenProgressFactKind;
    occurred_at: Date | string;
  }>(
    "SELECT order_batch_id::text,order_item_id::text,fact_kind,occurred_at FROM rms_ordering.order_kitchen_progress_fact " +
      where +
      " ORDER BY source_event_id,fact_ordinal LIMIT 100001",
    values,
  );
  if (termination.rows.length > 1 || kitchen.rows.length > 100000)
    throw new Error("ORDER_CANONICAL_PHASE_UNAVAILABLE");
  const terminationPhase = termination.rows[0]?.phase;
  const facts: OrderKitchenProgressFact[] = kitchen.rows.map((row) => ({
    orderBatchReference: row.order_batch_id,
    orderItemReference: row.order_item_id,
    kind: row.fact_kind,
    occurredAt: iso(row.occurred_at),
  }));
  return resolveOrderCanonicalPhase(
    {
      items: items.rows.map((row) => ({
        orderItemReference: row.order_item_id,
        orderBatchReference: row.order_batch_id,
      })),
      acceptedBatches: accepted.rows.map((row) => row.order_batch_id),
      cancelledBatches: [...checkoutCancelled.rows, ...staffCancelled.rows].map(
        (row) => row.order_batch_id,
      ),
      cancelledItems: itemsCancelled.rows.flatMap((row) => uuidList(row.order_item_ids)),
      termination:
        terminationPhase === undefined
          ? null
          : terminationPhase === "Cancelled" || terminationPhase === "Rejected"
            ? { phase: terminationPhase }
            : (() => {
                throw new Error("ORDER_CANONICAL_PHASE_UNAVAILABLE");
              })(),
      fulfilled: fulfilled.rows.length > 0,
    },
    facts,
  );
}
