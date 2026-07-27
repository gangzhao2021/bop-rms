import type { AppendAuditRecordInput, AuditTransaction } from "../../contracts/audit-record.js";
import { validateAuditRecord } from "../../contracts/validate-audit-record.js";

const sql = `INSERT INTO platform_audit.audit_record (
  audit_id, brand_id, store_id, actor_type, actor_reference,
  action_code, target_type, target_id, before_summary_json, after_summary_json,
  reason_code, correlation_id, occurred_at, source_channel,
  device_network_reference, data_classification, retention_policy_code,
  retention_policy_version, corrects_audit_id
) VALUES (
  $1, $2, $3, $4, $5,
  $6, $7, $8, $9::jsonb, $10::jsonb,
  $11, $12, $13, $14,
  $15, $16, $17, $18, $19
)`;

export async function appendAuditRecordInTransaction(
  transaction: AuditTransaction,
  input: AppendAuditRecordInput,
): Promise<void> {
  const record = validateAuditRecord(input);
  await transaction.query(sql, [
    record.auditId,
    record.brandId,
    record.storeId ?? null,
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
  ]);
}
