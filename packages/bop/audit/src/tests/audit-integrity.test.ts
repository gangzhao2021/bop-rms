import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_CHAIN_VERSION,
  AUDIT_KMS_KEY_SPEC,
  AUDIT_KMS_MESSAGE_TYPE,
  AUDIT_KMS_SIGNING_ALGORITHM,
  buildDailyAuditDigest,
  canonicalizeRfc8785,
  computeAuditRecordHash,
  InvalidAuditDigestError,
  InvalidCanonicalJsonError,
  sha256Hex,
  signAuditDailyManifest,
  verifyAuditIntegrity,
  type AuditArchiveReceiptV1,
  type AuditChainContentV1,
  type AuditChainRecordV1,
  type AuditDigestSignatureVerifier,
  type AuditDigestSigner,
  type SignedAuditDailyManifestV1,
} from "../index.js";

const id = (digit: string) => `018f1f48-7b5d-7cc${digit}-8a1b-123456789abc`;
const partition = { brandId: id("1"), storeId: id("2") };
const content = (auditId: string): AuditChainContentV1 => ({
  auditId,
  brandId: partition.brandId,
  storeId: partition.storeId,
  actorType: "System",
  actorReference: null,
  impersonationReference: null,
  actionCode: "SYNTHETIC_CHANGED",
  targetType: "SyntheticTarget",
  targetId: id("3"),
  beforeSummary: { state: "before" },
  afterSummary: { state: "after" },
  reasonCode: "SYNTHETIC_ACCEPTANCE",
  correlationId: id("4"),
  occurredAt: "2026-07-27T12:00:00.000Z",
  sourceChannel: "SYSTEM",
  deviceNetworkReference: null,
  dataClassification: "Internal",
  retentionPolicyCode: "AUDIT_DEFAULT",
  retentionPolicyVersion: 1,
  correctsAuditId: null,
});

function chainRecord(
  sequence: number,
  previousHash: string | null,
  recordedAt: string,
): AuditChainRecordV1 {
  const record = {
    version: AUDIT_CHAIN_VERSION,
    sequence,
    previousHash,
    recordedAt,
    content: content(id(String(sequence + 4))),
  };
  return { ...record, recordHash: computeAuditRecordHash(record) };
}

const records = () => {
  const first = chainRecord(1, null, "2026-07-27T01:00:00.123Z");
  const second = chainRecord(2, first.recordHash, "2026-07-27T23:59:59.999Z");
  return [first, second] as const;
};

function syntheticCrypto() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signer: AuditDigestSigner = {
    signDigest: vi.fn(async (input) => ({
      keyReference: "synthetic-node-p256-not-kms",
      signature: sign("sha256", input.digest, privateKey),
    })),
  };
  const verifier: AuditDigestSignatureVerifier = {
    verifyDigest: vi.fn(
      async (input) =>
        input.keyReference === "synthetic-node-p256-not-kms" &&
        input.keySpec === AUDIT_KMS_KEY_SPEC &&
        input.signingAlgorithm === AUDIT_KMS_SIGNING_ALGORITHM &&
        input.messageType === AUDIT_KMS_MESSAGE_TYPE &&
        verify("sha256", input.digest, publicKey, input.signature),
    ),
  };
  return { signer, verifier };
}

async function fixture(): Promise<{
  signed: SignedAuditDailyManifestV1;
  verifier: AuditDigestSignatureVerifier;
  receipt: AuditArchiveReceiptV1;
}> {
  const manifest = buildDailyAuditDigest({
    manifestId: id("0"),
    partition,
    day: "2026-07-27",
    records: records(),
  });
  const crypto = syntheticCrypto();
  const signed = await signAuditDailyManifest(manifest, crypto.signer);
  return {
    signed,
    verifier: crypto.verifier,
    receipt: {
      objectVersionId: "synthetic-version-1",
      manifestSha256: manifest.manifestSha256,
      signatureSha256: sha256Hex(Buffer.from(signed.signatureBase64, "base64")),
      encryption: { mode: "aws:kms", keyReference: "synthetic-archive-kms-reference" },
      objectLock: { mode: "GOVERNANCE", retainUntil: "2026-08-27T00:00:00.000Z" },
      archivedAt: "2026-07-28T00:00:00.000Z",
    },
  };
}

describe("RFC 8785 canonical JSON", () => {
  it("uses ECMAScript serialization and UTF-16 property ordering", () => {
    expect(
      canonicalizeRfc8785({
        numbers: [Number("333333333.33333329"), 1e30, 4.5, 0.002, 1e-27, -0],
        z: "line\n€",
        a: true,
      }),
    ).toBe('{"a":true,"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0],"z":"line\\n€"}');
    expect(canonicalizeRfc8785({ "\u{1f600}": 1, "\ufffd": 2, "\u20ac": 3 })).toBe(
      '{"€":3,"😀":1,"�":2}',
    );
  });

  it.each([
    ["non-finite", { value: Number.NaN }],
    ["unsupported", { value: undefined }],
    ["lone surrogate value", { value: "\ud800" }],
    ["lone surrogate key", { "\udc00": true }],
    ["non-plain object", new Date("2026-07-27T00:00:00.000Z")],
  ])("rejects %s", (_name, value) => {
    expect(() => canonicalizeRfc8785(value)).toThrow(InvalidCanonicalJsonError);
  });

  it("rejects cycles and sparse arrays", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalizeRfc8785(cycle)).toThrow(InvalidCanonicalJsonError);
    const sparse = Array.from({ length: 2 }) as unknown[];
    sparse[1] = true;
    expect(() => canonicalizeRfc8785(sparse)).toThrow(InvalidCanonicalJsonError);
    const symbol = { safe: true };
    Object.defineProperty(symbol, Symbol("hidden"), { value: true, enumerable: true });
    expect(() => canonicalizeRfc8785(symbol)).toThrow(InvalidCanonicalJsonError);
    const accessor = {};
    Object.defineProperty(accessor, "unsafe", { enumerable: true, get: () => true });
    expect(() => canonicalizeRfc8785(accessor)).toThrow(InvalidCanonicalJsonError);
  });
});

describe("Audit daily digest", () => {
  it("builds an exact non-empty UTC manifest and changes the root on content mutation", () => {
    const source = records();
    const manifest = buildDailyAuditDigest({
      manifestId: id("0"),
      partition,
      day: "2026-07-27",
      records: source,
    });
    expect(manifest).toMatchObject({
      version: "AUDIT_DAILY_MANIFEST_V1",
      firstSequence: 1,
      lastSequence: 2,
      recordCount: 2,
      rootHash: source[1].recordHash,
      gapCount: 0,
      rangeStart: "2026-07-27T00:00:00.000Z",
      rangeEnd: "2026-07-28T00:00:00.000Z",
    });
    expect(manifest.manifestSha256).toMatch(/^[0-9a-f]{64}$/u);

    const changed = { ...source[1], content: { ...source[1].content, reasonCode: "OTHER" } };
    expect(
      computeAuditRecordHash({
        content: changed.content,
        previousHash: changed.previousHash,
        recordedAt: changed.recordedAt,
        sequence: changed.sequence,
      }),
    ).not.toBe(source[1].recordHash);
  });

  it.each([
    ["empty", []],
    ["duplicate", [records()[0], { ...records()[1], sequence: 1 }]],
    ["gap", [records()[0], { ...records()[1], sequence: 3 }]],
    ["out of order", [records()[1], records()[0]]],
    ["previous hash", [records()[0], { ...records()[1], previousHash: "0".repeat(64) }]],
    ["record hash", [records()[0], { ...records()[1], recordHash: "0".repeat(64) }]],
  ])("rejects %s chain input", (_name, source) => {
    expect(() =>
      buildDailyAuditDigest({
        manifestId: id("0"),
        partition,
        day: "2026-07-27",
        records: source,
      }),
    ).toThrow(InvalidAuditDigestError);
  });

  it("locks the signing port to the KMS P-256 digest contract", async () => {
    const source = records();
    const manifest = buildDailyAuditDigest({
      manifestId: id("0"),
      partition,
      day: "2026-07-27",
      records: source,
    });
    const { signer } = syntheticCrypto();
    const signed = await signAuditDailyManifest(manifest, signer);
    expect(signer.signDigest).toHaveBeenCalledWith({
      keySpec: AUDIT_KMS_KEY_SPEC,
      signingAlgorithm: AUDIT_KMS_SIGNING_ALGORITHM,
      messageType: AUDIT_KMS_MESSAGE_TYPE,
      digest: Buffer.from(manifest.manifestSha256, "hex"),
    });
    expect(signed.keyReference).toBe("synthetic-node-p256-not-kms");
  });

  it("refuses an unknown chain-content field and an inconsistent manifest before signing", async () => {
    expect(() =>
      computeAuditRecordHash({
        content: { ...content(id("5")), unrestricted: true } as never,
        previousHash: null,
        recordedAt: "2026-07-27T01:00:00.123Z",
        sequence: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_AUDIT_CHAIN" }));

    const manifest = buildDailyAuditDigest({
      manifestId: id("0"),
      partition,
      day: "2026-07-27",
      records: records(),
    });
    const { signer } = syntheticCrypto();
    await expect(signAuditDailyManifest({ ...manifest, recordCount: 99 }, signer)).rejects.toThrow(
      InvalidAuditDigestError,
    );
    expect(signer.signDigest).not.toHaveBeenCalled();
  });
});

describe("Audit integrity verifier", () => {
  it("accepts the exact synthetic chain, head, signature and archive receipt", async () => {
    const evidence = await fixture();
    await expect(
      verifyAuditIntegrity({
        records: records(),
        head: { nextSequence: 3, lastRecordHash: records()[1].recordHash },
        signedManifest: evidence.signed,
        signatureVerifier: evidence.verifier,
        archiveReceipt: evidence.receipt,
      }),
    ).resolves.toEqual({
      ok: true,
      freezeHighRiskExport: false,
      alertClass: null,
      failures: [],
    });
  });

  it.each([
    ["head", "HEAD_MISMATCH"],
    ["manifest", "MANIFEST_MISMATCH"],
    ["signature", "SIGNATURE_INVALID"],
    ["key reference", "SIGNATURE_INVALID"],
    ["archive version", "ARCHIVE_VERSION_INVALID"],
    ["archive hash", "ARCHIVE_HASH_MISMATCH"],
    ["archive signature", "ARCHIVE_SIGNATURE_MISMATCH"],
    ["archive encryption", "ARCHIVE_ENCRYPTION_INVALID"],
    ["archive lock", "ARCHIVE_LOCK_INVALID"],
    ["archive retention", "ARCHIVE_RETENTION_INVALID"],
  ] as const)("fails closed on %s mutation", async (kind, code) => {
    const evidence = await fixture();
    let signed: unknown = structuredClone(evidence.signed);
    let receipt: unknown = structuredClone(evidence.receipt);
    const head = { nextSequence: 3, lastRecordHash: records()[1].recordHash };
    if (kind === "head") head.nextSequence = 4;
    if (kind === "manifest") {
      const current = signed as SignedAuditDailyManifestV1;
      signed = { ...current, manifest: { ...current.manifest, recordCount: 99 } };
    }
    if (kind === "signature") {
      const current = signed as SignedAuditDailyManifestV1;
      signed = { ...current, signatureBase64: Buffer.from("invalid").toString("base64") };
    }
    if (kind === "key reference") {
      const current = signed as SignedAuditDailyManifestV1;
      signed = { ...current, keyReference: "synthetic-wrong-key" };
    }
    if (kind === "archive version")
      receipt = { ...(receipt as AuditArchiveReceiptV1), objectVersionId: "null" };
    if (kind === "archive hash")
      receipt = { ...(receipt as AuditArchiveReceiptV1), manifestSha256: "0".repeat(64) };
    if (kind === "archive signature")
      receipt = { ...(receipt as AuditArchiveReceiptV1), signatureSha256: "0".repeat(64) };
    if (kind === "archive encryption") {
      const current = receipt as AuditArchiveReceiptV1;
      receipt = { ...current, encryption: { ...current.encryption, mode: "AES256" } };
    }
    if (kind === "archive lock") {
      const current = receipt as AuditArchiveReceiptV1;
      receipt = { ...current, objectLock: { ...current.objectLock, mode: "COMPLIANCE" } };
    }
    if (kind === "archive retention") {
      const current = receipt as AuditArchiveReceiptV1;
      receipt = {
        ...current,
        objectLock: { ...current.objectLock, retainUntil: "2026-07-27T00:00:00.000Z" },
      };
    }

    const result = await verifyAuditIntegrity({
      records: records(),
      head,
      signedManifest: signed as SignedAuditDailyManifestV1,
      signatureVerifier: evidence.verifier,
      archiveReceipt: receipt as AuditArchiveReceiptV1,
    });
    expect(result).toMatchObject({
      ok: false,
      freezeHighRiskExport: true,
      alertClass: "AUDIT_INTEGRITY_FAILED",
    });
    expect(result.failures).toContain(code);
    expect(JSON.stringify(result)).not.toMatch(/SyntheticTarget|before|after|018f1f48/iu);
  });

  it("treats missing archive and verifier exceptions as closed failures", async () => {
    const evidence = await fixture();
    const result = await verifyAuditIntegrity({
      records: records(),
      head: { nextSequence: 3, lastRecordHash: records()[1].recordHash },
      signedManifest: evidence.signed,
      signatureVerifier: {
        verifyDigest: async () => {
          throw new Error("provider details must not escape");
        },
      },
      archiveReceipt: null,
    });
    expect(result.failures).toEqual(["ARCHIVE_MISSING", "SIGNATURE_INVALID"]);
    expect(JSON.stringify(result)).not.toContain("provider details");
  });

  it("never throws or reflects malformed runtime input", async () => {
    const result = await verifyAuditIntegrity({
      records: [{ unsafe: "restricted-content" }],
      head: null,
      signedManifest: null,
      signatureVerifier: null,
    } as never);
    expect(result).toEqual({
      ok: false,
      freezeHighRiskExport: true,
      alertClass: "AUDIT_INTEGRITY_FAILED",
      failures: ["INVALID_RECORD"],
    });
    expect(JSON.stringify(result)).not.toContain("restricted-content");
  });
});
