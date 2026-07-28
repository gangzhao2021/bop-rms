import { createHash } from "node:crypto";
import type { AppendAuditRecordInput, JsonObject } from "./audit-record.js";
import { canonicalizeRfc8785 } from "./canonicalize-rfc8785.js";
import { validateAuditRecord } from "./validate-audit-record.js";

export const AUDIT_CHAIN_VERSION = "AUDIT_CHAIN_V1" as const;
export const AUDIT_CHAIN_VERIFIER_VERSION = "AUDIT_CHAIN_VERIFIER_V1" as const;
export const AUDIT_DAILY_MANIFEST_VERSION = "AUDIT_DAILY_MANIFEST_V1" as const;
export const AUDIT_KMS_KEY_SPEC = "ECC_NIST_P256" as const;
export const AUDIT_KMS_SIGNING_ALGORITHM = "ECDSA_SHA_256" as const;
export const AUDIT_KMS_MESSAGE_TYPE = "DIGEST" as const;

export interface AuditChainContentV1 {
  readonly auditId: string;
  readonly brandId: string;
  readonly storeId: string | null;
  readonly actorType: "User" | "System" | "Service";
  readonly actorReference: string | null;
  readonly impersonationReference: null;
  readonly actionCode: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly beforeSummary: JsonObject;
  readonly afterSummary: JsonObject;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly occurredAt: string;
  readonly sourceChannel: string;
  readonly deviceNetworkReference: string | null;
  readonly dataClassification: "Public" | "Internal" | "Confidential" | "Restricted";
  readonly retentionPolicyCode: string;
  readonly retentionPolicyVersion: number;
  readonly correctsAuditId: string | null;
}

export interface AuditChainRecordV1 {
  readonly version: typeof AUDIT_CHAIN_VERSION;
  readonly sequence: number;
  readonly previousHash: string | null;
  readonly recordHash: string;
  readonly recordedAt: string;
  readonly content: AuditChainContentV1;
}

export interface AuditChainHead {
  readonly nextSequence: number;
  readonly lastRecordHash: string | null;
}

export interface AuditPartition {
  readonly brandId: string;
  readonly storeId: string | null;
}

export interface AuditDailyManifestV1 {
  readonly version: typeof AUDIT_DAILY_MANIFEST_VERSION;
  readonly manifestId: string;
  readonly partition: AuditPartition;
  readonly day: string;
  readonly rangeStart: string;
  readonly rangeEnd: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly recordCount: number;
  readonly rootHash: string;
  readonly gapCount: 0;
  readonly chainVerifierVersion: typeof AUDIT_CHAIN_VERIFIER_VERSION;
  readonly manifestSha256: string;
}

export interface AuditDigestSigner {
  signDigest(input: {
    readonly keySpec: typeof AUDIT_KMS_KEY_SPEC;
    readonly signingAlgorithm: typeof AUDIT_KMS_SIGNING_ALGORITHM;
    readonly messageType: typeof AUDIT_KMS_MESSAGE_TYPE;
    readonly digest: Uint8Array;
  }): Promise<{
    readonly keyReference: string;
    readonly signature: Uint8Array;
  }>;
}

export interface AuditDigestSignatureVerifier {
  verifyDigest(input: {
    readonly keyReference: string;
    readonly keySpec: typeof AUDIT_KMS_KEY_SPEC;
    readonly signingAlgorithm: typeof AUDIT_KMS_SIGNING_ALGORITHM;
    readonly messageType: typeof AUDIT_KMS_MESSAGE_TYPE;
    readonly digest: Uint8Array;
    readonly signature: Uint8Array;
  }): Promise<boolean>;
}

export interface SignedAuditDailyManifestV1 {
  readonly manifest: AuditDailyManifestV1;
  readonly keyReference: string;
  readonly keySpec: typeof AUDIT_KMS_KEY_SPEC;
  readonly signingAlgorithm: typeof AUDIT_KMS_SIGNING_ALGORITHM;
  readonly messageType: typeof AUDIT_KMS_MESSAGE_TYPE;
  readonly signatureBase64: string;
}

export interface AuditArchiveReceiptV1 {
  readonly objectVersionId: string;
  readonly manifestSha256: string;
  readonly signatureSha256: string;
  readonly encryption: {
    readonly mode: "aws:kms";
    readonly keyReference: string;
  };
  readonly objectLock: {
    readonly mode: "GOVERNANCE";
    readonly retainUntil: string;
  };
  readonly archivedAt: string;
}

export type AuditIntegrityFailureCode =
  | "ARCHIVE_ENCRYPTION_INVALID"
  | "ARCHIVE_HASH_MISMATCH"
  | "ARCHIVE_LOCK_INVALID"
  | "ARCHIVE_MISSING"
  | "ARCHIVE_RETENTION_INVALID"
  | "ARCHIVE_SIGNATURE_MISMATCH"
  | "ARCHIVE_VERSION_INVALID"
  | "HEAD_MISMATCH"
  | "INVALID_RECORD"
  | "MANIFEST_MISMATCH"
  | "PREVIOUS_HASH_MISMATCH"
  | "RECORD_HASH_MISMATCH"
  | "SEQUENCE_DUPLICATE"
  | "SEQUENCE_GAP"
  | "SEQUENCE_OUT_OF_ORDER"
  | "SIGNATURE_INVALID";

export type AuditIntegrityVerificationResult =
  | {
      readonly ok: true;
      readonly freezeHighRiskExport: false;
      readonly alertClass: null;
      readonly failures: readonly [];
    }
  | {
      readonly ok: false;
      readonly freezeHighRiskExport: true;
      readonly alertClass: "AUDIT_INTEGRITY_FAILED";
      readonly failures: readonly AuditIntegrityFailureCode[];
    };

const hexSha256 = /^[0-9a-f]{64}$/u;
const utcMilliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const contentFields = [
  "actionCode",
  "actorReference",
  "actorType",
  "afterSummary",
  "auditId",
  "beforeSummary",
  "brandId",
  "correlationId",
  "correctsAuditId",
  "dataClassification",
  "deviceNetworkReference",
  "impersonationReference",
  "occurredAt",
  "reasonCode",
  "retentionPolicyCode",
  "retentionPolicyVersion",
  "sourceChannel",
  "storeId",
  "targetId",
  "targetType",
] as const;

export class InvalidAuditChainError extends TypeError {
  readonly code = "INVALID_AUDIT_CHAIN";
  constructor() {
    super("invalid Audit chain value");
    this.name = "InvalidAuditChainError";
  }
}

export function validateAuditChainContent(content: AuditChainContentV1): void {
  if (
    !content ||
    typeof content !== "object" ||
    Array.isArray(content) ||
    Object.keys(content).sort().join(",") !== [...contentFields].sort().join(",") ||
    content.impersonationReference !== null ||
    (content.actorType === "System" && content.actorReference !== null) ||
    ((content.actorType === "User" || content.actorType === "Service") &&
      typeof content.actorReference !== "string")
  )
    throw new InvalidAuditChainError();
  const occurredAt = Date.parse(content.occurredAt);
  const actor =
    content.actorType === "System"
      ? ({ type: "System" } as const)
      : ({ type: content.actorType, reference: content.actorReference } as const);
  try {
    validateAuditRecord(
      {
        auditId: content.auditId,
        brandId: content.brandId,
        ...(content.storeId === null ? {} : { storeId: content.storeId }),
        actor,
        actionCode: content.actionCode,
        targetType: content.targetType,
        targetId: content.targetId,
        beforeSummary: content.beforeSummary,
        afterSummary: content.afterSummary,
        reasonCode: content.reasonCode,
        correlationId: content.correlationId,
        occurredAt: content.occurredAt,
        sourceChannel: content.sourceChannel,
        ...(content.deviceNetworkReference === null
          ? {}
          : { deviceNetworkReference: content.deviceNetworkReference }),
        dataClassification: content.dataClassification,
        retentionPolicyCode: content.retentionPolicyCode,
        retentionPolicyVersion: content.retentionPolicyVersion,
        ...(content.correctsAuditId === null ? {} : { correctsAuditId: content.correctsAuditId }),
      },
      occurredAt + 300_000,
    );
  } catch {
    throw new InvalidAuditChainError();
  }
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computeAuditRecordHash(input: {
  readonly content: AuditChainContentV1;
  readonly previousHash: string | null;
  readonly recordedAt: string;
  readonly sequence: number;
  readonly version?: typeof AUDIT_CHAIN_VERSION;
}): string {
  const version = input.version ?? AUDIT_CHAIN_VERSION;
  const recordedAtMs =
    typeof input.recordedAt === "string" ? Date.parse(input.recordedAt) : Number.NaN;
  if (
    version !== AUDIT_CHAIN_VERSION ||
    !Number.isSafeInteger(input.sequence) ||
    input.sequence <= 0 ||
    (input.previousHash !== null && !hexSha256.test(input.previousHash)) ||
    (input.sequence === 1 && input.previousHash !== null) ||
    (input.sequence > 1 && input.previousHash === null) ||
    !utcMilliseconds.test(input.recordedAt) ||
    !Number.isFinite(recordedAtMs) ||
    new Date(recordedAtMs).toISOString() !== input.recordedAt
  )
    throw new InvalidAuditChainError();
  validateAuditChainContent(input.content);
  return sha256Hex(
    canonicalizeRfc8785({
      content: input.content,
      previousHash: input.previousHash,
      recordedAt: input.recordedAt,
      sequence: input.sequence,
      version,
    }),
  );
}

export function auditChainContent(input: AppendAuditRecordInput): AuditChainContentV1 {
  return {
    auditId: input.auditId,
    brandId: input.brandId,
    storeId: input.storeId ?? null,
    actorType: input.actor.type,
    actorReference: input.actor.type === "System" ? null : input.actor.reference,
    impersonationReference: null,
    actionCode: input.actionCode,
    targetType: input.targetType,
    targetId: input.targetId,
    beforeSummary: input.beforeSummary ?? {},
    afterSummary: input.afterSummary ?? {},
    reasonCode: input.reasonCode,
    correlationId: input.correlationId,
    occurredAt: input.occurredAt,
    sourceChannel: input.sourceChannel,
    deviceNetworkReference: input.deviceNetworkReference ?? null,
    dataClassification: input.dataClassification,
    retentionPolicyCode: input.retentionPolicyCode,
    retentionPolicyVersion: input.retentionPolicyVersion,
    correctsAuditId: input.correctsAuditId ?? null,
  };
}
