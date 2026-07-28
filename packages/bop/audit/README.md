# Audit integrity contract

`@bop/audit` owns the technical append contract for `platform_audit.audit_record` and the
per-Brand/Store `audit_chain_head`. A caller supplies an already-authorized Audit fact and an open
database transaction. The package validates the fact, locks only its exact chain partition,
allocates the next positive sequence, obtains the exact millisecond UTC `recordedAt` from
PostgreSQL, hashes the `AUDIT_CHAIN_V1` RFC 8785 preimage, inserts the record and advances the head
inside that same transaction.

The public integrity contract also builds a non-empty per-partition UTC daily manifest, signs its
32-byte SHA-256 digest through the closed `ECC_NIST_P256` / `ECDSA_SHA_256` / `DIGEST` port and
verifies the record chain, head, manifest, signature and immutable-archive receipt. Any verifier
failure returns only stable codes, `AUDIT_INTEGRITY_FAILED` and `freezeHighRiskExport=true`; it does
not mutate authorization or export state.

Local and CI signature tests use an ephemeral Node P-256 key and are `SYNTHETIC / NOT KMS`. This
package creates no AWS key, bucket, role, credential, retention duration or scheduler. A repository
receipt check is not proof of S3 Object Lock. Real KMS signing, versioned cross-account archive,
Governance retention, delete denial, restore verification and legal retention evidence remain
external gates owned by later Work Packages.
