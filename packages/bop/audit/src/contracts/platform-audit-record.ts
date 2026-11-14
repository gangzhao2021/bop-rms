import { canonicalizeRfc8785 } from "./canonicalize-rfc8785.js";
import { sha256Hex } from "./audit-integrity.js";

export interface AppendPlatformAuditRecordInput {
  readonly auditReference: string;
  readonly actorReference: string;
  readonly purposeCode: string;
  readonly actionCode: string;
  readonly targetType: string;
  readonly targetReference: string;
  readonly operationReference: string;
  readonly intentDigest: string;
  readonly occurredAt: string;
  readonly reasonCode: string;
  readonly retentionPolicyCode: "CONFIGURATION_AUDIT";
  readonly retentionPolicyVersion: number;
}
export const platformAuditChainProfile = "PlatformAuditChainRecordV1" as const;
export interface PlatformAuditChainRecordV1 {
  readonly profile: typeof platformAuditChainProfile;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly recordHash: string;
  readonly recordedAt: string;
  readonly content: AppendPlatformAuditRecordInput;
}
export type PlatformAuditHashInput = Omit<PlatformAuditChainRecordV1, "recordHash">;
export class InvalidPlatformAuditRecordError extends TypeError {
  readonly code = "PLATFORM_AUDIT_INPUT_INVALID";
  constructor() {
    super("Platform Audit input is invalid");
    this.name = "InvalidPlatformAuditRecordError";
  }
}
const fail = (): never => {
  throw new InvalidPlatformAuditRecordError();
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_]{0,127}$/u;
const target = /^[A-Z][A-Za-z0-9]{0,127}$/u;
const hex = /^[0-9a-f]{64}$/u;
function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value),
    keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    fields.some((field) => !Object.hasOwn(descriptors, field)) ||
    keys.some(
      (field) =>
        typeof field !== "string" ||
        !fields.includes(field) ||
        !descriptors[field]?.enumerable ||
        !("value" in descriptors[field]),
    )
  )
    return fail();
  return Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value]));
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) return fail();
  return value;
}
function instant(value: unknown): string {
  const result = text(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  const ms = Date.parse(result);
  if (result.startsWith("0000-") || !Number.isFinite(ms) || new Date(ms).toISOString() !== result)
    fail();
  return result;
}
export function parsePlatformAuditInput(value: unknown): AppendPlatformAuditRecordInput {
  const r = exact(value, [
    "auditReference",
    "actorReference",
    "purposeCode",
    "actionCode",
    "targetType",
    "targetReference",
    "operationReference",
    "intentDigest",
    "occurredAt",
    "reasonCode",
    "retentionPolicyCode",
    "retentionPolicyVersion",
  ]);
  if (
    r.retentionPolicyCode !== "CONFIGURATION_AUDIT" ||
    !Number.isInteger(r.retentionPolicyVersion) ||
    (r.retentionPolicyVersion as number) < 1 ||
    (r.retentionPolicyVersion as number) > 2147483647
  )
    fail();
  const parsed = Object.freeze({
    auditReference: text(r.auditReference, uuid),
    actorReference: text(r.actorReference, uuid),
    purposeCode: text(r.purposeCode, code),
    actionCode: text(r.actionCode, code),
    targetType: text(r.targetType, target),
    targetReference: text(r.targetReference, uuid),
    operationReference: text(r.operationReference, uuid),
    intentDigest: text(r.intentDigest, /^sha256:[0-9a-f]{64}$/u),
    occurredAt: instant(r.occurredAt),
    reasonCode: text(r.reasonCode, code),
    retentionPolicyCode: "CONFIGURATION_AUDIT" as const,
    retentionPolicyVersion: r.retentionPolicyVersion as number,
  });
  if (
    parsed.targetType === "PlatformBrandTemplateOperation" &&
    parsed.targetReference !== parsed.operationReference
  )
    fail();
  return parsed;
}
function hashInput(value: unknown): PlatformAuditHashInput {
  const r = exact(value, ["profile", "sequence", "previousHash", "recordedAt", "content"]);
  if (
    r.profile !== platformAuditChainProfile ||
    !Number.isSafeInteger(r.sequence) ||
    (r.sequence as number) < 1
  )
    fail();
  const previousHash = r.previousHash === null ? null : text(r.previousHash, hex);
  if (((r.sequence as number) === 1) !== (previousHash === null)) fail();
  const content = parsePlatformAuditInput(r.content),
    recordedAt = instant(r.recordedAt);
  if (content.occurredAt > recordedAt) fail();
  return Object.freeze({
    profile: platformAuditChainProfile,
    sequence: r.sequence as number,
    previousHash,
    recordedAt,
    content,
  });
}
export function computePlatformAuditRecordHash(value: PlatformAuditHashInput): string {
  return sha256Hex(canonicalizeRfc8785(hashInput(value)));
}
export function parsePlatformAuditChainRecord(value: unknown): PlatformAuditChainRecordV1 {
  const r = exact(value, [
    "profile",
    "sequence",
    "previousHash",
    "recordHash",
    "recordedAt",
    "content",
  ]);
  const input = hashInput({
    profile: r.profile,
    sequence: r.sequence,
    previousHash: r.previousHash,
    recordedAt: r.recordedAt,
    content: r.content,
  });
  return Object.freeze({ ...input, recordHash: text(r.recordHash, hex) });
}
/** Verifies a complete genesis-to-tail partition; it does not assert publication or permission. */
export function verifyPlatformAuditChain(value: unknown): boolean {
  try {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1
    )
      return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1) return false;
    let previous: PlatformAuditChainRecordV1 | null = null;
    const references = new Set<string>();
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
      const record = parsePlatformAuditChainRecord(descriptor.value);
      const { recordHash, ...input } = record;
      if (
        record.sequence !== index + 1 ||
        record.previousHash !== (previous?.recordHash ?? null) ||
        computePlatformAuditRecordHash(input) !== recordHash ||
        references.has(record.content.auditReference) ||
        (previous !== null &&
          (previous.content.actorReference !== record.content.actorReference ||
            previous.content.purposeCode !== record.content.purposeCode ||
            previous.recordedAt > record.recordedAt))
      )
        return false;
      references.add(record.content.auditReference);
      previous = record;
    }
    return true;
  } catch {
    return false;
  }
}
