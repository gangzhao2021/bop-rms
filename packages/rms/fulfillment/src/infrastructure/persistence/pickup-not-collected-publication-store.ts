import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import { createPickupNotCollectedEvent } from "../../application/pickup-not-collected-event.js";
import { PickupHandoffError } from "../../domain/pickup-handoff.js";
import { parsePickupProofReference } from "../../domain/pickup-proof.js";

const at = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value));

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: records the one PickupNotCollected event of a not-collected
 * closure and appends it to the outbox in the caller's transaction. The publication record's key
 * (one per closure) makes a second publication of the same closure fail instead of duplicating it.
 */
export async function appendPickupNotCollectedPublication(
  transaction: ConsumerTransaction,
  input: {
    readonly eventReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly fulfillmentReference: string;
    readonly orderReference: string;
    readonly notCollectedReference: string;
    readonly correlationReference: string;
    readonly aggregateVersionBefore: bigint;
    readonly readyAt: string;
    readonly closedAt: string;
  },
) {
  const event = createPickupNotCollectedEvent(input);
  const inserted = await transaction.query(
    "INSERT INTO rms_fulfillment.pickup_not_collected_publication (pickup_not_collected_id,brand_id,store_id," +
      "fulfillment_id,order_id,outbox_event_id,closed_at,data_classification) VALUES ($1,$2,$3,$4,$5,$6,$7,'IndirectIdentifier')",
    [
      event.payload.notCollectedReference,
      event.tenantId,
      event.storeId,
      event.payload.fulfillmentReference,
      event.payload.orderReference,
      event.eventId,
      event.payload.closedAt,
    ],
  );
  if (inserted.rowCount !== 1) throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
  await appendEventInTransaction(transaction, event);
  return event;
}

/**
 * Catch-up for closures recorded before Fulfillment published them: publishes each of this Store's
 * not-collected closures that has no publication yet. Idempotent: a second run finds none.
 */
export function createPostgresPickupNotCollectedPublisher(options: {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly nextReference: () => string;
}) {
  const brand = parsePickupProofReference(options.brandReference),
    store = parsePickupProofReference(options.storeReference);
  return Object.freeze({
    async publishMissing(transaction: ConsumerTransaction) {
      await transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const missing = await transaction.query<{
        pickup_not_collected_id: string;
        fulfillment_id: string;
        order_id: string;
        correlation_id: string;
        aggregate_version_before: string;
        ready_at: Date | string;
        closed_at: Date | string;
      }>(
        "SELECT n.pickup_not_collected_id::text,n.fulfillment_id::text,f.order_id::text,n.correlation_id::text," +
          "n.aggregate_version_before::text,n.ready_at,n.closed_at FROM rms_fulfillment.pickup_not_collected_record n " +
          "JOIN rms_fulfillment.fulfillment f ON f.brand_id=n.brand_id AND f.store_id=n.store_id AND f.fulfillment_id=n.fulfillment_id " +
          "WHERE n.brand_id=$1 AND n.store_id=$2 AND NOT EXISTS (SELECT 1 FROM rms_fulfillment.pickup_not_collected_publication p " +
          "WHERE p.brand_id=n.brand_id AND p.store_id=n.store_id AND p.pickup_not_collected_id=n.pickup_not_collected_id) " +
          "ORDER BY n.closed_at,n.pickup_not_collected_id LIMIT 10001",
        [brand, store],
      );
      if (missing.rows.length > 10000) throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
      const published: string[] = [];
      for (const row of missing.rows) {
        const event = await appendPickupNotCollectedPublication(transaction, {
          eventReference: options.nextReference(),
          brandReference: brand,
          storeReference: store,
          fulfillmentReference: row.fulfillment_id,
          orderReference: row.order_id,
          notCollectedReference: row.pickup_not_collected_id,
          correlationReference: row.correlation_id,
          aggregateVersionBefore: BigInt(row.aggregate_version_before),
          readyAt: at(row.ready_at),
          closedAt: at(row.closed_at),
        });
        published.push(event.eventId);
      }
      return Object.freeze(published);
    },
  });
}
