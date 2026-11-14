import { parseCanonicalInstant, parseOpaqueUuidV7 } from "../../contracts/identity-actor.js";
import {
  parseGuestAdmissionEvidence,
  parseGuestOperationReference,
  type GuestAdmissionEvidence,
} from "../../contracts/guest-session.js";
import type { GuestSessionEntryTransaction } from "./guest-session-entry-store.js";
const unavailable = (): never => {
  throw new Error("GUEST_ENTRY_ADMISSION_UNAVAILABLE");
};
/** Caller supplies a trusted clock and retains this transaction through session
 * creation. Authorization must fence current Tenant association, purpose and abuse
 * policy. A supplied Allowed record alone never establishes that authorization.
 */
export function createPostgresGuestEntryAdmissionStore(options: {
  brandReference: string;
  storeReference: string;
  authorize(
    tx: GuestSessionEntryTransaction,
    evidence: GuestAdmissionEvidence,
    at: string,
  ): Promise<boolean>;
  appendAudit(
    tx: GuestSessionEntryTransaction,
    input: {
      evidence: GuestAdmissionEvidence;
      operationReference: string;
      auditReference: string;
      consumedAt: string;
    },
  ): Promise<void>;
}) {
  const brand = parseOpaqueUuidV7(options.brandReference, "IDENTITY_INPUT_INVALID");
  const store = parseOpaqueUuidV7(options.storeReference, "IDENTITY_INPUT_INVALID");
  return Object.freeze({
    async consume(
      tx: GuestSessionEntryTransaction,
      input: {
        evidence: unknown;
        operationReference: string;
        auditReference: string;
        requestedAt: string;
      },
    ): Promise<GuestAdmissionEvidence | null> {
      const evidence = parseGuestAdmissionEvidence(input.evidence);
      const operation = parseGuestOperationReference(input.operationReference);
      const auditReference = parseOpaqueUuidV7(input.auditReference, "IDENTITY_INPUT_INVALID");
      const at = parseCanonicalInstant(input.requestedAt);
      if (
        String(evidence.brandReference) !== brand ||
        String(evidence.storeReference) !== store ||
        String(evidence.entryRequestReference) === operation ||
        evidence.evaluatedAt > at ||
        evidence.validUntil <= at
      )
        return null;
      if ((await options.authorize(tx, evidence, at)) !== true) return null;
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const result = await tx.query(
        "INSERT INTO bop_identity.guest_entry_admission (brand_id,store_id,entry_request_id,operation_id,evidence_id,audit_reference,evidence_json,consumed_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING RETURNING entry_request_id",
        [
          brand,
          store,
          evidence.entryRequestReference,
          operation,
          evidence.evidenceReference,
          auditReference,
          JSON.stringify(evidence),
          at,
        ],
      );
      if (!result || typeof result !== "object") return unavailable();
      const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
      if (
        !descriptor ||
        !("value" in descriptor) ||
        !Array.isArray(descriptor.value) ||
        descriptor.value.length > 1
      )
        return unavailable();
      if (descriptor.value.length === 0) return null;
      if (descriptor.value[0]?.entry_request_id !== evidence.entryRequestReference)
        return unavailable();
      await options.appendAudit(tx, {
        evidence,
        operationReference: operation,
        auditReference,
        consumedAt: at,
      });
      if ((await options.authorize(tx, evidence, at)) !== true) return unavailable();
      return evidence;
    },
  });
}
