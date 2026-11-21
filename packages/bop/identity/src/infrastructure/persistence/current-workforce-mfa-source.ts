import { createWorkforceMfaStatus } from "../../contracts/workforce-identity-security.js";
import { parseOpaqueUuidV7, parseCanonicalInstant } from "../../contracts/identity-actor.js";
import { readClosedRecord } from "../../contracts/identity-actor.js";

interface Transaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const denied = (): never => {
  throw new Error("WORKFORCE_MFA_SOURCE_DENIED");
};
/** Identity-owned fact read. Caller authorization must bind the actor to its
 * scoped purpose. Retain this transaction through the protected operation.
 * No credential or challenge is returned; recency policy belongs to the caller.
 */
export function createPostgresCurrentWorkforceMfaSource(options: {
  authorize(tx: Transaction, actorReference: string, observedAt: string): Promise<boolean>;
}) {
  return async (tx: Transaction, value: unknown) => {
    const raw = readClosedRecord(value, ["actorReference", "observedAt"]);
    const actorReference = parseOpaqueUuidV7(raw.actorReference, "ACTOR_REFERENCE_INVALID");
    const observedAt = parseCanonicalInstant(raw.observedAt);
    const authorize = async () => {
      if ((await options.authorize(tx, actorReference, observedAt)) !== true) return denied();
    };
    await authorize();
    const result = await tx.query(
      "SELECT actor_id,status,provider_evidence_id,verified_at,reset_at,version FROM bop_identity.workforce_mfa_status WHERE actor_id=$1 FOR SHARE",
      [actorReference],
    );
    if (result === null || typeof result !== "object") return denied();
    const rows = Object.getOwnPropertyDescriptor(result, "rows");
    if (!rows || !("value" in rows) || !Array.isArray(rows.value) || rows.value.length !== 1)
      return denied();
    const row = readClosedRecord(rows.value[0], [
      "actor_id",
      "status",
      "provider_evidence_id",
      "verified_at",
      "reset_at",
      "version",
    ]);
    const instant = (value: unknown) => {
      if (value === null) return null;
      if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return denied();
      return parseCanonicalInstant(value.toISOString());
    };
    const status = createWorkforceMfaStatus({
      actorReference: row.actor_id,
      status: row.status,
      providerEvidenceReference: row.provider_evidence_id,
      verifiedAt: instant(row.verified_at),
      resetAt: instant(row.reset_at),
      version: row.version,
    });
    if (
      status.actorReference !== actorReference ||
      (status.verifiedAt !== null && status.verifiedAt > observedAt) ||
      (status.resetAt !== null && status.resetAt > observedAt) ||
      (status.status === "TotpVerified" && status.providerEvidenceReference === null)
    )
      return denied();
    await authorize();
    return status;
  };
}
