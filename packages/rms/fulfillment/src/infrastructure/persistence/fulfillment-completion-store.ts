import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import { parsePickupHandoffEffect } from "../../contracts/pickup-handoff.js";
import { createFulfillmentCompletionPublication } from "../../application/fulfillment-completed-event.js";
import { FulfillmentCompletedEventError } from "../../contracts/fulfillment-completed-event.js";

/** Internal writer: the handoff owner holds current source locks and the enclosing savepoint. */
export async function appendFulfillmentCompletion(
  transaction: ConsumerTransaction,
  input: {
    readonly effect: unknown;
    readonly orderReference: string;
    readonly sha256: (value: string) => string;
    readonly deriveReference: (kind: "Publication" | "Event", identity: string) => string;
  },
) {
  const effect = parsePickupHandoffEffect(input.effect),
    r = effect.record,
    o = effect.operation;
  if (effect.nextPhase !== "Completed") throw new FulfillmentCompletedEventError();
  const identity = r.fulfillmentReference + ":" + o.operationReference;
  const publication = createFulfillmentCompletionPublication({
    publicationReference: input.deriveReference("Publication", identity),
    eventReference: input.deriveReference("Event", identity),
    brandReference: r.brandReference,
    storeReference: r.storeReference,
    fulfillmentReference: r.fulfillmentReference,
    orderReference: input.orderReference,
    aggregateVersion: effect.nextAggregateVersion,
    handoffRecordReference: r.handoffReference,
    verificationMethod: r.verificationMethod,
    completedAt: r.handedOverAt,
    correlationReference: o.correlationReference,
    causationReference: o.operationReference,
    completionPhase: effect.nextPhase,
  });
  const digest = input.sha256(publication.semanticBinding);
  if (!/^sha256:[0-9a-f]{64}$/.test(digest)) throw new FulfillmentCompletedEventError();
  const result = await transaction.query(
    "INSERT INTO rms_fulfillment.fulfillment_completion_publication (" +
      "fulfillment_completion_publication_id,brand_id,store_id,fulfillment_id,order_id,pickup_handoff_id," +
      "verification_method,aggregate_version,outbox_event_id,event_semantic_digest,correlation_id," +
      "causation_operation_id,completed_at,data_classification,retention_policy_code) " +
      "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'IndirectIdentifier','FulfillmentBusinessRecord')",
    [
      publication.publicationReference,
      r.brandReference,
      r.storeReference,
      r.fulfillmentReference,
      input.orderReference,
      r.handoffReference,
      r.verificationMethod,
      effect.nextAggregateVersion.toString(),
      publication.event.eventId,
      digest,
      o.correlationReference,
      o.operationReference,
      r.handedOverAt,
    ],
  );
  if (result.rowCount !== 1) throw new FulfillmentCompletedEventError();
  await appendEventInTransaction(transaction, publication.event);
  return publication;
}
