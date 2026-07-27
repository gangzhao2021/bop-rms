import type { AppendAuditRecordInput, JsonObject, JsonValue } from "./audit-record.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const stableCode = /^[A-Z][A-Z0-9_]{0,127}$/u;
const targetType = /^[A-Z][A-Za-z0-9]{0,127}$/u;
const classifications = new Set(["Public", "Internal", "Confidential", "Restricted"]);
const prohibitedKeys =
  /(?:secret|token|password|credential|authorization|cookie|session|pan|cvv|card.?number|provider.?payload|request.?body|health|allerg)/iu;
const prohibitedValues =
  /(?:\bBearer\s+[A-Za-z0-9._~-]+|sk_(?:live|test)_[A-Za-z0-9]+|-----BEGIN [A-Z ]+PRIVATE KEY-----)/u;
const recordFields = new Set([
  "actionCode",
  "actor",
  "afterSummary",
  "auditId",
  "beforeSummary",
  "brandId",
  "correlationId",
  "correctsAuditId",
  "dataClassification",
  "deviceNetworkReference",
  "occurredAt",
  "reasonCode",
  "retentionPolicyCode",
  "retentionPolicyVersion",
  "sourceChannel",
  "storeId",
  "targetId",
  "targetType",
]);

export class InvalidAuditRecordError extends TypeError {
  readonly code = "INVALID_AUDIT_RECORD";
  constructor(readonly field: string) {
    super(`invalid Audit Record field: ${field}`);
    this.name = "InvalidAuditRecordError";
  }
}

function requireUuid(field: string, value: unknown): void {
  if (typeof value !== "string" || !uuidV7.test(value)) throw new InvalidAuditRecordError(field);
}

function inspectJson(value: JsonValue, state: { fields: number }, field: string, depth = 1): void {
  if (depth > 8) throw new InvalidAuditRecordError(field);
  if (typeof value === "string") {
    if (value.length > 2048 || prohibitedValues.test(value))
      throw new InvalidAuditRecordError(field);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new InvalidAuditRecordError(field);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) inspectJson(item, state, field, depth + 1);
    return;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new InvalidAuditRecordError(field);
  for (const [key, item] of Object.entries(value)) {
    state.fields += 1;
    if (state.fields > 128 || key.length === 0 || key.length > 64 || prohibitedKeys.test(key))
      throw new InvalidAuditRecordError(field);
    inspectJson(item, state, field, depth + 1);
  }
}

function summary(field: string, value: JsonObject | undefined): number {
  if (value === undefined) return 0;
  inspectJson(value, { fields: 0 }, field);
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > 16_384) throw new InvalidAuditRecordError(field);
  return bytes;
}

export function validateAuditRecord(input: unknown, now = Date.now()): AppendAuditRecordInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new InvalidAuditRecordError("record");
  if (Object.keys(input).some((field) => !recordFields.has(field)))
    throw new InvalidAuditRecordError("record");
  const candidate = input as AppendAuditRecordInput;
  requireUuid("auditId", candidate.auditId);
  requireUuid("brandId", candidate.brandId);
  if (candidate.storeId !== undefined) requireUuid("storeId", candidate.storeId);
  if (candidate.actor?.type === "System") {
    if (Object.keys(candidate.actor).length !== 1) throw new InvalidAuditRecordError("actor");
  } else if (candidate.actor?.type === "User" || candidate.actor?.type === "Service") {
    if (Object.keys(candidate.actor).length !== 2) throw new InvalidAuditRecordError("actor");
    requireUuid("actor.reference", candidate.actor.reference);
  } else throw new InvalidAuditRecordError("actor");
  if (!stableCode.test(candidate.actionCode)) throw new InvalidAuditRecordError("actionCode");
  if (!targetType.test(candidate.targetType)) throw new InvalidAuditRecordError("targetType");
  requireUuid("targetId", candidate.targetId);
  if (
    summary("beforeSummary", candidate.beforeSummary) +
      summary("afterSummary", candidate.afterSummary) >
    32_768
  )
    throw new InvalidAuditRecordError("summaries");
  if (!stableCode.test(candidate.reasonCode)) throw new InvalidAuditRecordError("reasonCode");
  requireUuid("correlationId", candidate.correlationId);
  const occurred = Date.parse(candidate.occurredAt);
  if (
    !candidate.occurredAt.endsWith("Z") ||
    !Number.isFinite(occurred) ||
    new Date(occurred).toISOString() !== candidate.occurredAt ||
    occurred > now + 300_000
  )
    throw new InvalidAuditRecordError("occurredAt");
  if (!stableCode.test(candidate.sourceChannel)) throw new InvalidAuditRecordError("sourceChannel");
  if (candidate.deviceNetworkReference !== undefined)
    requireUuid("deviceNetworkReference", candidate.deviceNetworkReference);
  if (!classifications.has(candidate.dataClassification))
    throw new InvalidAuditRecordError("dataClassification");
  if (!stableCode.test(candidate.retentionPolicyCode))
    throw new InvalidAuditRecordError("retentionPolicyCode");
  if (
    !Number.isSafeInteger(candidate.retentionPolicyVersion) ||
    candidate.retentionPolicyVersion <= 0
  )
    throw new InvalidAuditRecordError("retentionPolicyVersion");
  if (candidate.correctsAuditId !== undefined) {
    requireUuid("correctsAuditId", candidate.correctsAuditId);
    if (candidate.correctsAuditId === candidate.auditId)
      throw new InvalidAuditRecordError("correctsAuditId");
  }
  return candidate;
}
