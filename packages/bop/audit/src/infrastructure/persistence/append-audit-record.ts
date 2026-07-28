import {
  AUDIT_CHAIN_VERSION,
  auditChainContent,
  computeAuditRecordHash,
  type AuditChainRecordV1,
} from "../../contracts/audit-integrity.js";
import type { AppendAuditRecordInput, AuditTransaction } from "../../contracts/audit-record.js";
import { validateAuditRecord } from "../../contracts/validate-audit-record.js";

const initializeHeadSql = `INSERT INTO platform_audit.audit_chain_head (
  brand_id, store_id, next_sequence, last_record_hash
) VALUES ($1, $2, 1, NULL)
ON CONFLICT (brand_id, scope_store_key) DO NOTHING`;

const lockHeadSql = `SELECT
  next_sequence::text AS next_sequence,
  CASE WHEN last_record_hash IS NULL THEN NULL ELSE encode(last_record_hash, 'hex') END AS previous_hash,
  to_char(
    date_trunc('milliseconds', clock_timestamp()) AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ) AS recorded_at
FROM platform_audit.audit_chain_head
WHERE brand_id = $1 AND store_id IS NOT DISTINCT FROM $2
FOR UPDATE`;

const insertRecordSql = `INSERT INTO platform_audit.audit_record (
  audit_id, brand_id, store_id, actor_type, actor_reference,
  action_code, target_type, target_id, before_summary_json, after_summary_json,
  reason_code, correlation_id, occurred_at, source_channel,
  device_network_reference, data_classification, retention_policy_code,
  retention_policy_version, corrects_audit_id, recorded_at,
  chain_version, chain_sequence, previous_record_hash, record_hash
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9::jsonb, $10::jsonb,
  $11, $12, $13, $14,
  $15, $16, $17, $18, $19, $20,
  $21, $22, $23, $24
)`;

const advanceHeadSql = `UPDATE platform_audit.audit_chain_head
SET next_sequence = next_sequence + 1, last_record_hash = $3
WHERE brand_id = $1
  AND store_id IS NOT DISTINCT FROM $2
  AND next_sequence = $4
  AND last_record_hash IS NOT DISTINCT FROM $5
RETURNING next_sequence::text AS next_sequence`;

const hexSha256 = /^[0-9a-f]{64}$/u;
const utcMilliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class AuditPersistenceError extends Error {
  readonly code = "AUDIT_PERSISTENCE_FAILED";
  constructor() {
    super("Audit persistence invariant failed");
    this.name = "AuditPersistenceError";
  }
}

interface QueryResult {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

function queryResult(value: unknown): QueryResult {
  if (!value || typeof value !== "object") throw new AuditPersistenceError();
  return value as QueryResult;
}

function lockedHead(value: unknown): {
  sequence: number;
  previousHash: string | null;
  recordedAt: string;
} {
  const rows = queryResult(value).rows;
  const row = rows?.[0];
  const sequence = Number(row?.next_sequence);
  const previousHash = row?.previous_hash;
  const recordedAt = row?.recorded_at;
  const recordedAtMs = typeof recordedAt === "string" ? Date.parse(recordedAt) : Number.NaN;
  if (
    rows?.length !== 1 ||
    !Number.isSafeInteger(sequence) ||
    sequence <= 0 ||
    (previousHash !== null &&
      (typeof previousHash !== "string" || !hexSha256.test(previousHash))) ||
    typeof recordedAt !== "string" ||
    !utcMilliseconds.test(recordedAt) ||
    !Number.isFinite(recordedAtMs) ||
    new Date(recordedAtMs).toISOString() !== recordedAt ||
    (sequence === 1 && previousHash !== null) ||
    (sequence > 1 && previousHash === null)
  )
    throw new AuditPersistenceError();
  return { sequence, previousHash, recordedAt };
}

export async function appendAuditRecordInTransaction(
  transaction: AuditTransaction,
  input: AppendAuditRecordInput,
): Promise<AuditChainRecordV1> {
  const record = validateAuditRecord(input);
  const storeId = record.storeId ?? null;
  await transaction.query(initializeHeadSql, [record.brandId, storeId]);
  const allocation = lockedHead(await transaction.query(lockHeadSql, [record.brandId, storeId]));
  const content = auditChainContent(record);
  const recordHash = computeAuditRecordHash({
    content,
    previousHash: allocation.previousHash,
    recordedAt: allocation.recordedAt,
    sequence: allocation.sequence,
  });

  await transaction.query(insertRecordSql, [
    record.auditId,
    record.brandId,
    storeId,
    record.actor.type,
    record.actor.type === "System" ? null : record.actor.reference,
    record.actionCode,
    record.targetType,
    record.targetId,
    JSON.stringify(record.beforeSummary ?? {}),
    JSON.stringify(record.afterSummary ?? {}),
    record.reasonCode,
    record.correlationId,
    record.occurredAt,
    record.sourceChannel,
    record.deviceNetworkReference ?? null,
    record.dataClassification,
    record.retentionPolicyCode,
    record.retentionPolicyVersion,
    record.correctsAuditId ?? null,
    allocation.recordedAt,
    AUDIT_CHAIN_VERSION,
    allocation.sequence,
    allocation.previousHash === null ? null : Buffer.from(allocation.previousHash, "hex"),
    Buffer.from(recordHash, "hex"),
  ]);
  const advanced = queryResult(
    await transaction.query(advanceHeadSql, [
      record.brandId,
      storeId,
      Buffer.from(recordHash, "hex"),
      allocation.sequence,
      allocation.previousHash === null ? null : Buffer.from(allocation.previousHash, "hex"),
    ]),
  );
  if (
    advanced.rows?.length !== 1 ||
    Number(advanced.rows[0]?.next_sequence) !== allocation.sequence + 1
  )
    throw new AuditPersistenceError();
  return {
    version: AUDIT_CHAIN_VERSION,
    sequence: allocation.sequence,
    previousHash: allocation.previousHash,
    recordHash,
    recordedAt: allocation.recordedAt,
    content,
  };
}
