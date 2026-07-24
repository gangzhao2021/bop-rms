import type { DomainEventEnvelope } from "../../contracts/domain-event-envelope.js";
import type {
  ConsumerOutcome,
  ConsumerRegistration,
  ConsumerTransaction,
} from "../../contracts/consumer-inbox.js";
import { ConsumerTransactionRollback } from "../../contracts/consumer-inbox.js";
import { validateDomainEventEnvelope } from "../../contracts/validate-envelope.js";

const insertSql = `INSERT INTO platform_eventing.consumer_inbox (
  consumer_name, event_id, event_type, schema_version, brand_id, store_id,
  status, attempt_count, correlation_id
) VALUES ($1, $2, $3, $4, $5, $6, 'processing', 1, $7)
ON CONFLICT (consumer_name, event_id) DO NOTHING RETURNING consumer_name`;
const duplicateSql = `SELECT event_type, schema_version, brand_id::text, store_id::text, status
FROM platform_eventing.consumer_inbox WHERE consumer_name = $1 AND event_id = $2`;
const completeSql = `UPDATE platform_eventing.consumer_inbox
SET status = 'completed', processed_at = statement_timestamp(), result_hash = $3
WHERE consumer_name = $1 AND event_id = $2 AND status = 'processing'`;

export async function consumeEventInTransaction(
  transaction: ConsumerTransaction,
  registration: ConsumerRegistration,
  envelope: DomainEventEnvelope,
): Promise<ConsumerOutcome> {
  validateDomainEventEnvelope(envelope);
  if (
    (registration.tenantScope === "store" && !envelope.storeId) ||
    (registration.tenantScope === "brand" && envelope.storeId)
  )
    return { status: "rejected", errorCode: "TENANT_SCOPE_DENIED" };
  const inserted = await transaction.query(insertSql, [
    registration.consumerName,
    envelope.eventId,
    envelope.eventType,
    envelope.schemaVersion,
    envelope.tenantId,
    envelope.storeId ?? null,
    envelope.correlationId,
  ]);
  if (inserted.rowCount !== 1) {
    const duplicate = await transaction.query<{
      event_type: string;
      schema_version: number;
      brand_id: string;
      store_id: string | null;
      status: string;
    }>(duplicateSql, [registration.consumerName, envelope.eventId]);
    const row = duplicate.rows[0];
    if (
      !row ||
      row.status !== "completed" ||
      row.event_type !== envelope.eventType ||
      row.schema_version !== envelope.schemaVersion ||
      row.brand_id !== envelope.tenantId ||
      row.store_id !== (envelope.storeId ?? null)
    )
      return { status: "rejected", errorCode: "TENANT_SCOPE_DENIED" };
    return { status: "duplicate_completed" };
  }
  const result = await registration.handler({ envelope, transaction });
  if (result && result.status !== "completed") throw new ConsumerTransactionRollback(result);
  const resultHash = result?.resultHash ?? null;
  if (resultHash !== null && !/^[0-9a-f]{64}$/u.test(resultHash))
    throw new TypeError("resultHash must be a lowercase SHA-256 digest");
  const completed = await transaction.query(completeSql, [
    registration.consumerName,
    envelope.eventId,
    resultHash,
  ]);
  if (completed.rowCount !== 1) throw new Error("CONSUMER_INBOX_COMPLETE_NOT_CONFIRMED");
  return { status: "processed" };
}
