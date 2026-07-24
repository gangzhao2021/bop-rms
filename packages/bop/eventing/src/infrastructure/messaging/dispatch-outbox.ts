import type { DomainEventEnvelope, JsonObject } from "../../contracts/domain-event-envelope.js";
import {
  outboxDispatchErrorCodes,
  type ClaimedOutboxEvent,
  type OutboxCompletionResult,
  type OutboxDispatchErrorCode,
} from "../../contracts/outbox-dispatch.js";
import { validateDomainEventEnvelope } from "../../contracts/validate-envelope.js";

export interface OutboxDispatchQueryResult<Row = Record<string, unknown>> {
  readonly rowCount: number | null;
  readonly rows: readonly Row[];
}

export interface OutboxDispatchTransaction {
  query<Row = Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ): Promise<OutboxDispatchQueryResult<Row>>;
}

export interface ClaimOutboxBatchInput {
  readonly batchSize: number;
  readonly leaseDurationSeconds: number;
  readonly leaseOwner: string;
  readonly leaseToken: string;
}

interface ClaimedRow {
  readonly event_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly occurred_at: Date | string;
  readonly producer_module: DomainEventEnvelope["producerModule"];
  readonly brand_id: string;
  readonly store_id: string | null;
  readonly aggregate_type: string;
  readonly aggregate_id: string;
  readonly aggregate_version: string;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly actor_type: "Actor" | "System";
  readonly actor_id: string | null;
  readonly payload_json: JsonObject;
  readonly redaction_classification: DomainEventEnvelope["redactionClassification"];
  readonly replay_metadata_json: JsonObject;
  readonly attempt_count: number;
  readonly lease_expires_at: Date | string;
  readonly lease_token: string;
}

const claimSql = `WITH candidates AS (
  SELECT candidate.event_id
  FROM platform_eventing.outbox_event AS candidate
  WHERE candidate.published_at IS NULL
    AND candidate.last_error_code IS NULL
    AND candidate.attempt_count < 8
    AND candidate.available_at <= statement_timestamp()
    AND (
      (
        platform_helpers.current_store_id() IS NULL
        AND candidate.store_id IS NULL
      )
      OR candidate.store_id = platform_helpers.current_store_id()
    )
    AND (
      candidate.lease_token IS NULL
      OR candidate.lease_expires_at <= statement_timestamp()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM platform_eventing.outbox_event AS earlier
      WHERE earlier.brand_id = candidate.brand_id
        AND earlier.aggregate_type = candidate.aggregate_type
        AND earlier.aggregate_id = candidate.aggregate_id
        AND earlier.published_at IS NULL
        AND earlier.ordering_released_at IS NULL
        AND (earlier.aggregate_version, earlier.event_id)
          < (candidate.aggregate_version, candidate.event_id)
    )
  ORDER BY candidate.available_at, candidate.recorded_at, candidate.event_id
  FOR UPDATE OF candidate SKIP LOCKED
  LIMIT $1
)
UPDATE platform_eventing.outbox_event AS claimed
SET lease_token = $2,
    lease_owner = $3,
    lease_expires_at = statement_timestamp() + ($4 * interval '1 second'),
    attempt_count = claimed.attempt_count + 1
FROM candidates
WHERE claimed.event_id = candidates.event_id
RETURNING
  claimed.event_id::text,
  claimed.event_type,
  claimed.schema_version,
  claimed.occurred_at,
  claimed.producer_module,
  claimed.brand_id::text,
  claimed.store_id::text,
  claimed.aggregate_type,
  claimed.aggregate_id::text,
  claimed.aggregate_version::text,
  claimed.correlation_id::text,
  claimed.causation_id::text,
  claimed.actor_type,
  claimed.actor_id::text,
  claimed.payload_json,
  claimed.redaction_classification,
  claimed.replay_metadata_json,
  claimed.attempt_count,
  claimed.lease_expires_at,
  claimed.lease_token::text`;

const completeSql = `UPDATE platform_eventing.outbox_event
SET published_at = statement_timestamp(),
    lease_token = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = NULL
WHERE event_id = $1
  AND lease_token = $2
  AND published_at IS NULL`;

const failSql = `UPDATE platform_eventing.outbox_event
SET lease_token = NULL,
    lease_owner = NULL,
    lease_expires_at = NULL,
    last_error_code = $3
WHERE event_id = $1
  AND lease_token = $2
  AND published_at IS NULL`;

const positiveInteger = (value: number, name: string, maximum: number): void => {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
};

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const leaseOwnerPattern = /^[a-z][a-z0-9_-]{0,63}$/u;

const instant = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function toClaim(row: ClaimedRow): ClaimedOutboxEvent {
  const actor =
    row.actor_type === "System"
      ? ({ type: "System" } as const)
      : ({ type: "Actor", actorId: row.actor_id ?? "" } as const);
  const envelope: DomainEventEnvelope = {
    eventId: row.event_id,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    occurredAt: instant(row.occurred_at),
    producerModule: row.producer_module,
    tenantId: row.brand_id,
    ...(row.store_id ? { storeId: row.store_id } : {}),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: BigInt(row.aggregate_version),
    correlationId: row.correlation_id,
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    actor,
    payload: row.payload_json,
    redactionClassification: row.redaction_classification,
    replayMetadata: row.replay_metadata_json,
  };
  validateDomainEventEnvelope(envelope);
  return {
    attemptCount: row.attempt_count,
    envelope,
    leaseExpiresAt: instant(row.lease_expires_at),
    leaseToken: row.lease_token,
  };
}

export async function claimOutboxBatch(
  transaction: OutboxDispatchTransaction,
  input: ClaimOutboxBatchInput,
): Promise<readonly ClaimedOutboxEvent[]> {
  positiveInteger(input.batchSize, "batchSize", 100);
  positiveInteger(input.leaseDurationSeconds, "leaseDurationSeconds", 300);
  if (!uuidV7.test(input.leaseToken)) throw new TypeError("leaseToken must be a UUIDv7");
  if (!leaseOwnerPattern.test(input.leaseOwner))
    throw new TypeError("leaseOwner must be an opaque safe identifier");
  const result = await transaction.query<ClaimedRow>(claimSql, [
    input.batchSize,
    input.leaseToken,
    input.leaseOwner,
    input.leaseDurationSeconds,
  ]);
  return result.rows.map(toClaim);
}

export async function markOutboxPublished(
  transaction: OutboxDispatchTransaction,
  input: { readonly eventId: string; readonly leaseToken: string },
): Promise<OutboxCompletionResult> {
  const result = await transaction.query(completeSql, [input.eventId, input.leaseToken]);
  return result.rowCount === 1 ? "completed" : "lost_lease";
}

export async function markOutboxFailed(
  transaction: OutboxDispatchTransaction,
  input: {
    readonly errorCode: OutboxDispatchErrorCode;
    readonly eventId: string;
    readonly leaseToken: string;
  },
): Promise<OutboxCompletionResult> {
  if (!outboxDispatchErrorCodes.includes(input.errorCode))
    throw new TypeError("errorCode is not an accepted dispatch error code");
  const result = await transaction.query(failSql, [
    input.eventId,
    input.leaseToken,
    input.errorCode,
  ]);
  return result.rowCount === 1 ? "completed" : "lost_lease";
}
