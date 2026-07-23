import type { DomainEventEnvelope } from "../../contracts/domain-event-envelope.js";
import { validateDomainEventEnvelope } from "../../contracts/validate-envelope.js";

export interface OutboxTransaction {
  query(text: string, values: readonly unknown[]): Promise<{ readonly rowCount: number | null }>;
}

const insertOutboxEvent = `INSERT INTO platform_eventing.outbox_event (
  event_id,
  event_type,
  schema_version,
  producer_module,
  brand_id,
  store_id,
  aggregate_type,
  aggregate_id,
  aggregate_version,
  correlation_id,
  causation_id,
  actor_type,
  actor_id,
  payload_json,
  redaction_classification,
  replay_metadata_json,
  occurred_at,
  available_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16::jsonb, $17, $18
)`;

export async function appendEventInTransaction(
  transaction: OutboxTransaction,
  envelope: DomainEventEnvelope,
  options: { readonly availableAt?: string } = {},
): Promise<void> {
  validateDomainEventEnvelope(envelope);
  const availableAt = options.availableAt ?? envelope.occurredAt;
  if (
    typeof availableAt !== "string" ||
    !availableAt.endsWith("Z") ||
    !Number.isFinite(Date.parse(availableAt)) ||
    new Date(availableAt).toISOString() !== availableAt
  )
    throw new TypeError("availableAt must be a canonical UTC instant");

  const result = await transaction.query(insertOutboxEvent, [
    envelope.eventId,
    envelope.eventType,
    envelope.schemaVersion,
    envelope.producerModule,
    envelope.tenantId,
    envelope.storeId ?? null,
    envelope.aggregateType,
    envelope.aggregateId,
    envelope.aggregateVersion.toString(),
    envelope.correlationId,
    envelope.causationId ?? null,
    envelope.actor.type,
    envelope.actor.type === "Actor" ? envelope.actor.actorId : null,
    JSON.stringify(envelope.payload),
    envelope.redactionClassification,
    JSON.stringify(envelope.replayMetadata),
    envelope.occurredAt,
    availableAt,
  ]);
  if (result.rowCount !== 1) throw new Error("OUTBOX_APPEND_NOT_CONFIRMED");
}
