import type { AuditTransaction } from "../../contracts/audit-record.js";
import {
  computePlatformAuditRecordHash,
  parsePlatformAuditInput,
  parsePlatformAuditChainRecord,
  platformAuditChainProfile,
  type AppendPlatformAuditRecordInput,
  type PlatformAuditChainRecordV1,
} from "../../contracts/platform-audit-record.js";

export class PlatformAuditPersistenceError extends Error {
  readonly code = "PLATFORM_AUDIT_PERSISTENCE_FAILED";
  constructor() {
    super("Platform Audit persistence invariant failed");
    this.name = "PlatformAuditPersistenceError";
  }
}
const initialize = `INSERT INTO platform_audit.platform_actor_audit_chain_head(actor_id,purpose_code,next_sequence,last_record_hash) VALUES($1,$2,1,NULL) ON CONFLICT(actor_id,purpose_code) DO NOTHING`;
const lock = `SELECT next_sequence::text AS next_sequence, CASE WHEN last_record_hash IS NULL THEN NULL ELSE encode(last_record_hash,'hex') END AS previous_hash, to_char(date_trunc('milliseconds',clock_timestamp()) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at FROM platform_audit.platform_actor_audit_chain_head WHERE actor_id=$1 AND purpose_code=$2 FOR UPDATE`;
const insert = `INSERT INTO platform_audit.platform_actor_audit_record(audit_id,actor_id,purpose_code,action_code,target_type,target_id,operation_id,intent_digest,occurred_at,reason_code,retention_policy_code,retention_policy_version,chain_profile,chain_sequence,previous_record_hash,record_hash,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING audit_id::text AS audit_reference`;
const advance = `UPDATE platform_audit.platform_actor_audit_chain_head SET next_sequence=next_sequence+1,last_record_hash=$3 WHERE actor_id=$1 AND purpose_code=$2 AND next_sequence=$4 AND last_record_hash IS NOT DISTINCT FROM $5 RETURNING next_sequence::text AS next_sequence`;
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object" || !("rows" in value) || !Array.isArray(value.rows))
    throw new PlatformAuditPersistenceError();
  return value.rows as readonly Record<string, unknown>[];
}
/** Caller owns the genuine Platform authority/GUCs, transaction, guards and COMMIT. */
export async function appendPlatformAuditRecordInTransaction(
  transaction: AuditTransaction,
  value: AppendPlatformAuditRecordInput,
): Promise<PlatformAuditChainRecordV1> {
  const content = parsePlatformAuditInput(value);
  try {
    const originalQuery = transaction.query;
    const assertQuery = (): void => {
      if (typeof originalQuery !== "function" || transaction.query !== originalQuery)
        throw new PlatformAuditPersistenceError();
    };
    const query = (sql: string, values: readonly unknown[]): Promise<unknown> => {
      assertQuery();
      return originalQuery.call(transaction, sql, values);
    };
    await query(initialize, [content.actorReference, content.purposeCode]);
    assertQuery();
    const allocationResult = await query(lock, [content.actorReference, content.purposeCode]);
    assertQuery();
    const allocation = rows(allocationResult);
    if (allocation.length !== 1) throw new PlatformAuditPersistenceError();
    const row = allocation[0],
      sequence = Number(row?.next_sequence);
    if (
      typeof row?.next_sequence !== "string" ||
      !/^[1-9][0-9]*$/u.test(row.next_sequence) ||
      !Number.isSafeInteger(sequence) ||
      sequence >= Number.MAX_SAFE_INTEGER
    )
      throw new PlatformAuditPersistenceError();
    const hashInput = {
      profile: platformAuditChainProfile,
      sequence,
      previousHash: row?.previous_hash as string | null,
      recordedAt: row?.recorded_at as string,
      content,
    };
    const recordHash = computePlatformAuditRecordHash(hashInput);
    const record = parsePlatformAuditChainRecord({ ...hashInput, recordHash });
    const previousBytes =
      record.previousHash === null ? null : Buffer.from(record.previousHash, "hex");
    const insertResult = await query(insert, [
      content.auditReference,
      content.actorReference,
      content.purposeCode,
      content.actionCode,
      content.targetType,
      content.targetReference,
      content.operationReference,
      Buffer.from(content.intentDigest.slice(7), "hex"),
      content.occurredAt,
      content.reasonCode,
      content.retentionPolicyCode,
      content.retentionPolicyVersion,
      record.profile,
      sequence,
      previousBytes,
      Buffer.from(recordHash, "hex"),
      record.recordedAt,
    ]);
    assertQuery();
    const inserted = rows(insertResult);
    if (inserted.length !== 1 || inserted[0]?.audit_reference !== content.auditReference)
      throw new PlatformAuditPersistenceError();
    const advanceResult = await query(advance, [
      content.actorReference,
      content.purposeCode,
      Buffer.from(recordHash, "hex"),
      sequence,
      previousBytes,
    ]);
    assertQuery();
    const advanced = rows(advanceResult);
    if (advanced.length !== 1 || advanced[0]?.next_sequence !== String(sequence + 1))
      throw new PlatformAuditPersistenceError();
    return record;
  } catch {
    throw new PlatformAuditPersistenceError();
  }
}
