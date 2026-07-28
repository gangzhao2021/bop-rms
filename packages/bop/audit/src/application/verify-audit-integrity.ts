import {
  AUDIT_KMS_KEY_SPEC,
  AUDIT_KMS_MESSAGE_TYPE,
  AUDIT_KMS_SIGNING_ALGORITHM,
  type AuditArchiveReceiptV1,
  type AuditChainHead,
  type AuditChainRecordV1,
  type AuditDigestSignatureVerifier,
  type AuditIntegrityFailureCode,
  type AuditIntegrityVerificationResult,
  type SignedAuditDailyManifestV1,
  sha256Hex,
} from "../contracts/audit-integrity.js";
import { canonicalizeRfc8785 } from "../contracts/canonicalize-rfc8785.js";
import {
  buildDailyAuditDigest,
  computeAuditManifestHash,
  InvalidAuditDigestError,
} from "./build-daily-audit-digest.js";

const hexSha256 = /^[0-9a-f]{64}$/u;
const safeVersion = /^[A-Za-z0-9._~+/=-]{1,1024}$/u;
const utcMilliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function result(failures: Set<AuditIntegrityFailureCode>): AuditIntegrityVerificationResult {
  if (failures.size === 0)
    return { ok: true, freezeHighRiskExport: false, alertClass: null, failures: [] };
  return {
    ok: false,
    freezeHighRiskExport: true,
    alertClass: "AUDIT_INTEGRITY_FAILED",
    failures: [...failures].sort(),
  };
}

function digestFailure(error: unknown): AuditIntegrityFailureCode {
  if (!(error instanceof InvalidAuditDigestError)) return "INVALID_RECORD";
  if (
    error.code === "SEQUENCE_DUPLICATE" ||
    error.code === "SEQUENCE_GAP" ||
    error.code === "SEQUENCE_OUT_OF_ORDER" ||
    error.code === "PREVIOUS_HASH_MISMATCH" ||
    error.code === "RECORD_HASH_MISMATCH"
  )
    return error.code;
  return "INVALID_RECORD";
}

function decodeBase64(value: string): Uint8Array | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 8_192 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  )
    return null;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 0 || bytes.toString("base64") !== value ? null : bytes;
}

function validInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return (
    utcMilliseconds.test(value) &&
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString() === value
  );
}

function verifyArchive(
  signed: SignedAuditDailyManifestV1,
  receipt: AuditArchiveReceiptV1 | null | undefined,
  signature: Uint8Array | null,
  failures: Set<AuditIntegrityFailureCode>,
): void {
  if (!receipt) {
    failures.add("ARCHIVE_MISSING");
    return;
  }
  if (!safeVersion.test(receipt.objectVersionId) || receipt.objectVersionId === "null")
    failures.add("ARCHIVE_VERSION_INVALID");
  if (
    !hexSha256.test(receipt.manifestSha256) ||
    receipt.manifestSha256 !== signed.manifest.manifestSha256
  )
    failures.add("ARCHIVE_HASH_MISMATCH");
  if (
    signature === null ||
    !hexSha256.test(receipt.signatureSha256) ||
    receipt.signatureSha256 !== sha256Hex(signature)
  )
    failures.add("ARCHIVE_SIGNATURE_MISMATCH");
  if (
    receipt.encryption?.mode !== "aws:kms" ||
    typeof receipt.encryption.keyReference !== "string" ||
    receipt.encryption.keyReference.trim().length === 0 ||
    receipt.encryption.keyReference.length > 2_048
  )
    failures.add("ARCHIVE_ENCRYPTION_INVALID");
  if (receipt.objectLock?.mode !== "GOVERNANCE") failures.add("ARCHIVE_LOCK_INVALID");

  const archivedAt = Date.parse(receipt.archivedAt);
  const retainUntil = Date.parse(receipt.objectLock?.retainUntil ?? "");
  if (
    !validInstant(receipt.archivedAt) ||
    !validInstant(receipt.objectLock?.retainUntil ?? "") ||
    retainUntil <= archivedAt
  )
    failures.add("ARCHIVE_RETENTION_INVALID");
}

async function verifyAuditIntegrityUnsafe(input: {
  readonly records: readonly AuditChainRecordV1[];
  readonly head: AuditChainHead;
  readonly signedManifest: SignedAuditDailyManifestV1;
  readonly signatureVerifier: AuditDigestSignatureVerifier;
  readonly archiveReceipt?: AuditArchiveReceiptV1 | null;
}): Promise<AuditIntegrityVerificationResult> {
  const failures = new Set<AuditIntegrityFailureCode>();
  const { manifest } = input.signedManifest;
  let expectedManifest: typeof manifest | null = null;
  try {
    expectedManifest = buildDailyAuditDigest({
      manifestId: manifest.manifestId,
      partition: manifest.partition,
      day: manifest.day,
      records: input.records,
    });
  } catch (error) {
    failures.add(digestFailure(error));
  }

  if (
    expectedManifest === null ||
    canonicalizeRfc8785(expectedManifest) !== canonicalizeRfc8785(manifest) ||
    !hexSha256.test(manifest.manifestSha256) ||
    computeAuditManifestHash({
      version: manifest.version,
      manifestId: manifest.manifestId,
      partition: manifest.partition,
      day: manifest.day,
      rangeStart: manifest.rangeStart,
      rangeEnd: manifest.rangeEnd,
      firstSequence: manifest.firstSequence,
      lastSequence: manifest.lastSequence,
      recordCount: manifest.recordCount,
      rootHash: manifest.rootHash,
      gapCount: manifest.gapCount,
      chainVerifierVersion: manifest.chainVerifierVersion,
    }) !== manifest.manifestSha256
  )
    failures.add("MANIFEST_MISMATCH");

  const last = input.records.at(-1);
  if (
    !last ||
    !Number.isSafeInteger(input.head.nextSequence) ||
    input.head.nextSequence !== last.sequence + 1 ||
    input.head.lastRecordHash !== last.recordHash
  )
    failures.add("HEAD_MISMATCH");

  const signature = decodeBase64(input.signedManifest.signatureBase64);
  if (
    signature === null ||
    !hexSha256.test(manifest.manifestSha256) ||
    input.signedManifest.keySpec !== AUDIT_KMS_KEY_SPEC ||
    input.signedManifest.signingAlgorithm !== AUDIT_KMS_SIGNING_ALGORITHM ||
    input.signedManifest.messageType !== AUDIT_KMS_MESSAGE_TYPE ||
    typeof input.signedManifest.keyReference !== "string" ||
    input.signedManifest.keyReference.trim().length === 0 ||
    input.signedManifest.keyReference.length > 2_048
  ) {
    failures.add("SIGNATURE_INVALID");
  } else {
    try {
      if (
        !(await input.signatureVerifier.verifyDigest({
          keyReference: input.signedManifest.keyReference,
          keySpec: AUDIT_KMS_KEY_SPEC,
          signingAlgorithm: AUDIT_KMS_SIGNING_ALGORITHM,
          messageType: AUDIT_KMS_MESSAGE_TYPE,
          digest: Buffer.from(manifest.manifestSha256, "hex"),
          signature,
        }))
      )
        failures.add("SIGNATURE_INVALID");
    } catch {
      failures.add("SIGNATURE_INVALID");
    }
  }

  verifyArchive(input.signedManifest, input.archiveReceipt, signature, failures);
  return result(failures);
}

export async function verifyAuditIntegrity(input: {
  readonly records: readonly AuditChainRecordV1[];
  readonly head: AuditChainHead;
  readonly signedManifest: SignedAuditDailyManifestV1;
  readonly signatureVerifier: AuditDigestSignatureVerifier;
  readonly archiveReceipt?: AuditArchiveReceiptV1 | null;
}): Promise<AuditIntegrityVerificationResult> {
  try {
    return await verifyAuditIntegrityUnsafe(input);
  } catch {
    return result(new Set<AuditIntegrityFailureCode>(["INVALID_RECORD"]));
  }
}
