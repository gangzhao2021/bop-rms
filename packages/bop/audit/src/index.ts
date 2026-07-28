export type {
  AppendAuditRecordInput,
  AuditActor,
  AuditClassification,
  AuditTransaction,
  JsonObject,
  JsonValue,
} from "./contracts/audit-record.js";
export {
  AUDIT_CHAIN_VERIFIER_VERSION,
  AUDIT_CHAIN_VERSION,
  AUDIT_DAILY_MANIFEST_VERSION,
  AUDIT_KMS_KEY_SPEC,
  AUDIT_KMS_MESSAGE_TYPE,
  AUDIT_KMS_SIGNING_ALGORITHM,
  auditChainContent,
  computeAuditRecordHash,
  sha256Hex,
  validateAuditChainContent,
} from "./contracts/audit-integrity.js";
export type {
  AuditArchiveReceiptV1,
  AuditChainContentV1,
  AuditChainHead,
  AuditChainRecordV1,
  AuditDailyManifestV1,
  AuditDigestSignatureVerifier,
  AuditDigestSigner,
  AuditIntegrityFailureCode,
  AuditIntegrityVerificationResult,
  AuditPartition,
  SignedAuditDailyManifestV1,
} from "./contracts/audit-integrity.js";
export { InvalidAuditChainError } from "./contracts/audit-integrity.js";
export {
  canonicalizeRfc8785,
  InvalidCanonicalJsonError,
} from "./contracts/canonicalize-rfc8785.js";
export { InvalidAuditRecordError, validateAuditRecord } from "./contracts/validate-audit-record.js";
export {
  buildDailyAuditDigest,
  computeAuditManifestHash,
  InvalidAuditDigestError,
  signAuditDailyManifest,
} from "./application/build-daily-audit-digest.js";
export { verifyAuditIntegrity } from "./application/verify-audit-integrity.js";
export {
  appendAuditRecordInTransaction,
  AuditPersistenceError,
} from "./infrastructure/persistence/append-audit-record.js";
