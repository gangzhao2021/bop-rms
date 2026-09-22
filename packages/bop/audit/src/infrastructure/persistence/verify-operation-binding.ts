import type { AuditTransaction } from "../../contracts/audit-record.js";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export interface AuditOperationBinding {
  auditId: string;
  brandId: string;
  storeId: string;
  actorReference: string;
  actionCode: string;
  targetType: string;
  targetId: string;
  occurredAt: string;
  sourceChannel: string;
  intentDigest: string;
  expectedVersion: number;
  resultingVersion: number;
}
/** Exact append-only operation/Audit binding, not a replacement for chain verification. */
export async function verifyAuditOperationBinding(
  transaction: AuditTransaction,
  input: AuditOperationBinding,
  authorize: () => Promise<boolean>,
): Promise<boolean> {
  try {
    if (
      [input.auditId, input.brandId, input.storeId, input.actorReference, input.targetId].some(
        (value) => !uuid.test(value),
      ) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(input.actionCode) ||
      !/^[A-Z][A-Za-z0-9]{0,127}$/u.test(input.targetType) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/u.test(input.sourceChannel) ||
      !/^sha256:[0-9a-f]{64}$/u.test(input.intentDigest) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.occurredAt) ||
      new Date(input.occurredAt).toISOString() !== input.occurredAt ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !Number.isSafeInteger(input.resultingVersion) ||
      input.resultingVersion !== input.expectedVersion + 1 ||
      (await authorize()) !== true
    )
      return false;
    const result = await transaction.query(
      "SELECT EXISTS (SELECT 1 FROM platform_audit.audit_record WHERE audit_id=$1 AND brand_id=$2 AND store_id=$3 AND actor_type='User' AND actor_reference=$4 AND action_code=$5 AND target_type=$6 AND target_id=$7 AND correlation_id=$7 AND occurred_at=$8 AND source_channel=$9 AND corrects_audit_id IS NULL AND after_summary_json=$10::jsonb) AS matched",
      [
        input.auditId,
        input.brandId,
        input.storeId,
        input.actorReference,
        input.actionCode,
        input.targetType,
        input.targetId,
        input.occurredAt,
        input.sourceChannel,
        JSON.stringify({
          intentDigest: input.intentDigest,
          expectedVersion: input.expectedVersion,
          resultingVersion: input.resultingVersion,
        }),
      ],
    );
    if (!result || typeof result !== "object") return false;
    const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !Array.isArray(descriptor.value) ||
      descriptor.value.length !== 1 ||
      descriptor.value[0]?.matched !== true
    )
      return false;
    return (await authorize()) === true;
  } catch {
    return false;
  }
}

export interface SystemAuditOperationBinding {
  auditId: string;
  brandId: string;
  storeId: string;
  actionCode: string;
  targetType: string;
  targetId: string;
  correlationId: string;
  reasonCode: string;
  occurredAt: string;
  sourceChannel: string;
}
/** Exact System audit linkage; does not replace full chain integrity verification. */
export async function verifySystemAuditOperationBinding(
  transaction: AuditTransaction,
  input: SystemAuditOperationBinding,
  authorize: () => Promise<boolean>,
): Promise<boolean> {
  try {
    if (
      [input.auditId, input.brandId, input.storeId, input.targetId, input.correlationId].some(
        (value) => !uuid.test(value),
      ) ||
      [input.actionCode, input.reasonCode, input.sourceChannel].some(
        (value) => !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value),
      ) ||
      !/^[A-Z][A-Za-z0-9]{0,127}$/u.test(input.targetType) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input.occurredAt) ||
      new Date(input.occurredAt).toISOString() !== input.occurredAt ||
      (await authorize()) !== true
    )
      return false;
    const result = await transaction.query(
      "SELECT EXISTS (SELECT 1 FROM platform_audit.audit_record WHERE audit_id=$1 AND brand_id=$2 AND store_id=$3 AND actor_type='System' AND actor_reference IS NULL AND action_code=$4 AND target_type=$5 AND target_id=$6 AND correlation_id=$7 AND reason_code=$8 AND occurred_at=$9 AND source_channel=$10 AND corrects_audit_id IS NULL) AS matched",
      [
        input.auditId,
        input.brandId,
        input.storeId,
        input.actionCode,
        input.targetType,
        input.targetId,
        input.correlationId,
        input.reasonCode,
        input.occurredAt,
        input.sourceChannel,
      ],
    );
    const descriptor =
      result && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rows")
        : undefined;
    if (
      !descriptor ||
      !("value" in descriptor) ||
      !Array.isArray(descriptor.value) ||
      descriptor.value.length !== 1 ||
      descriptor.value[0]?.matched !== true
    )
      return false;
    return (await authorize()) === true;
  } catch {
    return false;
  }
}
