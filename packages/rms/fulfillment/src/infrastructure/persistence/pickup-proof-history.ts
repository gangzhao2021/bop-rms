import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePickupProofIssueEffect,
  parsePickupProofVerificationRecord,
  PickupProofError,
} from "../../contracts/pickup-proof.js";

function unavailable(): never {
  throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
}
function instant(value: unknown) {
  return value instanceof Date ? value.toISOString() : value;
}
function version(value: unknown) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return unavailable();
  return BigInt(value);
}
/** Internal owner read: caller must authorize and hold the aggregate fence for current state. */
export async function readPickupProofHistory(
  tx: ConsumerTransaction,
  brand: string,
  store: string,
  fulfillment: string,
) {
  const args = [brand, store, fulfillment];
  const generations = (
    await tx.query(
      "SELECT * FROM rms_fulfillment.pickup_proof_generation WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 ORDER BY generation",
      args,
    )
  ).rows;
  const invalidations = (
    await tx.query(
      "SELECT * FROM rms_fulfillment.pickup_proof_invalidation WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
      args,
    )
  ).rows;
  const verifications = (
    await tx.query(
      "SELECT * FROM rms_fulfillment.pickup_proof_verification WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
      args,
    )
  ).rows;
  const operations = (
    await tx.query(
      "SELECT * FROM rms_fulfillment.pickup_proof_operation WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 ORDER BY generation,operation_kind",
      args,
    )
  ).rows;
  for (const row of [...generations, ...invalidations, ...verifications, ...operations])
    if (row.brand_id !== brand || row.store_id !== store || row.fulfillment_id !== fulfillment)
      return unavailable();
  const issues = operations
    .filter((row) => row.operation_kind !== "Verify")
    .map((o) => {
      const g = generations.find((row) => row.capability_id === o.capability_id);
      if (!g || o.verification_id !== null) return unavailable();
      const i = invalidations.find((row) => row.replacement_capability_id === g.capability_id);
      return parsePickupProofIssueEffect({
        generation: {
          capabilityReference: g.capability_id,
          fulfillmentReference: g.fulfillment_id,
          brandReference: g.brand_id,
          storeReference: g.store_id,
          kind: g.proof_kind,
          publicOrderReference: g.public_order_reference,
          selectorHash: g.selector_hash,
          pepperVersion: g.pepper_version,
          generation: g.generation,
          readyAt: instant(g.ready_at),
          expiresAt: instant(g.expires_at),
          issuedAt: instant(g.issued_at),
        },
        invalidation: i
          ? {
              invalidationReference: i.pickup_proof_invalidation_id,
              fulfillmentReference: i.fulfillment_id,
              priorCapabilityReference: i.prior_capability_id,
              replacementCapabilityReference: i.replacement_capability_id,
              priorGeneration: i.prior_generation,
              replacementGeneration: i.replacement_generation,
              invalidatedAt: instant(i.invalidated_at),
              reason: i.reason,
            }
          : null,
        operation: {
          operationReference: o.pickup_proof_operation_id,
          idempotencyReference: o.idempotency_id,
          correlationReference: o.correlation_id,
          fulfillmentReference: o.fulfillment_id,
          brandReference: o.brand_id,
          storeReference: o.store_id,
          operationKind: o.operation_kind,
          capabilityReference: o.capability_id,
          generation: o.generation,
          aggregateVersionBefore: version(o.aggregate_version_before),
          aggregateVersionAfter: version(o.aggregate_version_after),
          occurredAt: instant(o.occurred_at),
        },
      });
    });
  const validations = operations
    .filter((row) => row.operation_kind === "Verify")
    .map((o) => {
      const v = verifications.find((row) => row.pickup_proof_verification_id === o.verification_id);
      if (
        !v ||
        v.capability_id !== o.capability_id ||
        v.generation !== o.generation ||
        v.correlation_id !== o.correlation_id ||
        instant(v.verified_at) !== instant(o.occurred_at) ||
        o.aggregate_version_before !== null ||
        o.aggregate_version_after !== null
      )
        return unavailable();
      return parsePickupProofVerificationRecord({
        verificationReference: v.pickup_proof_verification_id,
        operationReference: o.pickup_proof_operation_id,
        idempotencyReference: o.idempotency_id,
        correlationReference: o.correlation_id,
        fulfillmentReference: v.fulfillment_id,
        brandReference: v.brand_id,
        storeReference: v.store_id,
        capabilityReference: v.capability_id,
        generation: v.generation,
        verificationMethod: v.verification_method,
        validationStatus: v.validation_status,
        verifiedAt: instant(v.verified_at),
        grantsCompletionAuthority: false,
      });
    });
  if (
    issues.length !== generations.length ||
    validations.length !== verifications.length ||
    issues.filter((e) => e.invalidation !== null).length !== invalidations.length
  )
    return unavailable();
  return { issues, verifications: validations };
}
