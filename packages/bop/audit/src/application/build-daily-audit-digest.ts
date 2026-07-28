import {
  AUDIT_CHAIN_VERIFIER_VERSION,
  AUDIT_CHAIN_VERSION,
  AUDIT_DAILY_MANIFEST_VERSION,
  AUDIT_KMS_KEY_SPEC,
  AUDIT_KMS_MESSAGE_TYPE,
  AUDIT_KMS_SIGNING_ALGORITHM,
  type AuditChainRecordV1,
  type AuditDailyManifestV1,
  type AuditDigestSigner,
  type AuditPartition,
  type SignedAuditDailyManifestV1,
  computeAuditRecordHash,
  sha256Hex,
  validateAuditChainContent,
} from "../contracts/audit-integrity.js";
import { canonicalizeRfc8785 } from "../contracts/canonicalize-rfc8785.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const hexSha256 = /^[0-9a-f]{64}$/u;
const utcDay = /^\d{4}-\d{2}-\d{2}$/u;
const utcMilliseconds = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type AuditDigestErrorCode =
  | "EMPTY_AUDIT_DAY"
  | "INVALID_MANIFEST_ID"
  | "INVALID_PARTITION"
  | "INVALID_RECORD"
  | "PREVIOUS_HASH_MISMATCH"
  | "RECORD_HASH_MISMATCH"
  | "SEQUENCE_DUPLICATE"
  | "SEQUENCE_GAP"
  | "SEQUENCE_OUT_OF_ORDER";

export class InvalidAuditDigestError extends TypeError {
  constructor(readonly code: AuditDigestErrorCode) {
    super(`invalid Audit daily digest input: ${code}`);
    this.name = "InvalidAuditDigestError";
  }
}

function exactUtcInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return (
    Number.isFinite(parsed) &&
    utcMilliseconds.test(value) &&
    new Date(parsed).toISOString() === value
  );
}

function dayRange(day: string): { rangeStart: string; rangeEnd: string } {
  if (!utcDay.test(day)) throw new InvalidAuditDigestError("INVALID_RECORD");
  const rangeStart = `${day}T00:00:00.000Z`;
  const start = Date.parse(rangeStart);
  if (!Number.isFinite(start) || new Date(start).toISOString() !== rangeStart)
    throw new InvalidAuditDigestError("INVALID_RECORD");
  return { rangeStart, rangeEnd: new Date(start + 86_400_000).toISOString() };
}

function validPartition(partition: AuditPartition): boolean {
  return (
    uuidV7.test(partition.brandId) && (partition.storeId === null || uuidV7.test(partition.storeId))
  );
}

function assertRecordShape(record: AuditChainRecordV1, partition: AuditPartition): void {
  if (
    record.version !== AUDIT_CHAIN_VERSION ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence <= 0 ||
    (record.previousHash !== null && !hexSha256.test(record.previousHash)) ||
    (record.sequence === 1 && record.previousHash !== null) ||
    (record.sequence > 1 && record.previousHash === null) ||
    !hexSha256.test(record.recordHash) ||
    !exactUtcInstant(record.recordedAt) ||
    record.content.brandId !== partition.brandId ||
    record.content.storeId !== partition.storeId
  )
    throw new InvalidAuditDigestError("INVALID_RECORD");
  try {
    validateAuditChainContent(record.content);
  } catch {
    throw new InvalidAuditDigestError("INVALID_RECORD");
  }
}

function withoutManifestHash(
  manifest: Omit<AuditDailyManifestV1, "manifestSha256">,
): Omit<AuditDailyManifestV1, "manifestSha256"> {
  return manifest;
}

export function computeAuditManifestHash(
  manifest: Omit<AuditDailyManifestV1, "manifestSha256">,
): string {
  return sha256Hex(canonicalizeRfc8785(withoutManifestHash(manifest)));
}

export function buildDailyAuditDigest(input: {
  readonly manifestId: string;
  readonly partition: AuditPartition;
  readonly day: string;
  readonly records: readonly AuditChainRecordV1[];
}): AuditDailyManifestV1 {
  if (!uuidV7.test(input.manifestId)) throw new InvalidAuditDigestError("INVALID_MANIFEST_ID");
  if (!validPartition(input.partition)) throw new InvalidAuditDigestError("INVALID_PARTITION");
  if (input.records.length === 0) throw new InvalidAuditDigestError("EMPTY_AUDIT_DAY");

  const { rangeStart, rangeEnd } = dayRange(input.day);
  let previousSequence: number | null = null;
  let previousHash: string | null | undefined;
  const seen = new Set<number>();
  for (const record of input.records) {
    assertRecordShape(record, input.partition);
    if (record.recordedAt < rangeStart || record.recordedAt >= rangeEnd)
      throw new InvalidAuditDigestError("INVALID_RECORD");
    if (seen.has(record.sequence)) throw new InvalidAuditDigestError("SEQUENCE_DUPLICATE");
    if (previousSequence !== null && record.sequence < previousSequence)
      throw new InvalidAuditDigestError("SEQUENCE_OUT_OF_ORDER");
    if (previousSequence !== null && record.sequence !== previousSequence + 1)
      throw new InvalidAuditDigestError("SEQUENCE_GAP");
    if (previousHash !== undefined && record.previousHash !== previousHash)
      throw new InvalidAuditDigestError("PREVIOUS_HASH_MISMATCH");
    if (
      computeAuditRecordHash({
        content: record.content,
        previousHash: record.previousHash,
        recordedAt: record.recordedAt,
        sequence: record.sequence,
        version: record.version,
      }) !== record.recordHash
    )
      throw new InvalidAuditDigestError("RECORD_HASH_MISMATCH");
    seen.add(record.sequence);
    previousSequence = record.sequence;
    previousHash = record.recordHash;
  }

  const first = input.records[0];
  const last = input.records.at(-1);
  if (!first || !last) throw new InvalidAuditDigestError("EMPTY_AUDIT_DAY");
  const unsigned = {
    version: AUDIT_DAILY_MANIFEST_VERSION,
    manifestId: input.manifestId,
    partition: input.partition,
    day: input.day,
    rangeStart,
    rangeEnd,
    firstSequence: first.sequence,
    lastSequence: last.sequence,
    recordCount: input.records.length,
    rootHash: last.recordHash,
    gapCount: 0 as const,
    chainVerifierVersion: AUDIT_CHAIN_VERIFIER_VERSION,
  };
  return { ...unsigned, manifestSha256: computeAuditManifestHash(unsigned) };
}

export async function signAuditDailyManifest(
  manifest: AuditDailyManifestV1,
  signer: AuditDigestSigner,
): Promise<SignedAuditDailyManifestV1> {
  if (
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
    throw new InvalidAuditDigestError("INVALID_RECORD");
  const signed = await signer.signDigest({
    keySpec: AUDIT_KMS_KEY_SPEC,
    signingAlgorithm: AUDIT_KMS_SIGNING_ALGORITHM,
    messageType: AUDIT_KMS_MESSAGE_TYPE,
    digest: Buffer.from(manifest.manifestSha256, "hex"),
  });
  if (
    typeof signed.keyReference !== "string" ||
    signed.keyReference.trim().length === 0 ||
    signed.keyReference.length > 2_048 ||
    !(signed.signature instanceof Uint8Array) ||
    signed.signature.byteLength === 0 ||
    signed.signature.byteLength > 6_144
  )
    throw new InvalidAuditDigestError("INVALID_RECORD");
  return {
    manifest,
    keyReference: signed.keyReference,
    keySpec: AUDIT_KMS_KEY_SPEC,
    signingAlgorithm: AUDIT_KMS_SIGNING_ALGORITHM,
    messageType: AUDIT_KMS_MESSAGE_TYPE,
    signatureBase64: Buffer.from(signed.signature).toString("base64"),
  };
}
