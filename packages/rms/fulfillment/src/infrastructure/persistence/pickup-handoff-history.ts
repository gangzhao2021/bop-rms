import type { ConsumerTransaction } from "@bop/eventing";
import {
  PickupHandoffError,
  parsePickupInPersonVerificationRecord,
} from "../../contracts/pickup-handoff.js";
import { decodePickupHandoffRecord } from "../../application/pickup-handoff-record.js";
function unavailable(): never {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
}
function at(value: unknown) {
  return value instanceof Date ? value.toISOString() : value;
}
/** Internal owner reader; current callers hold aggregate lock and authorization. */
export async function readPickupHandoffHistory(
  tx: ConsumerTransaction,
  brand: string,
  store: string,
  fulfillment: string,
) {
  const args = [brand, store, fulfillment];
  const operations = (
    await tx.query(
      "SELECT *,handoff_record_json::text AS record_json FROM rms_fulfillment.pickup_handoff_operation WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 ORDER BY aggregate_version_after",
      args,
    )
  ).rows;
  const records = (
    await tx.query(
      "SELECT * FROM rms_fulfillment.pickup_handoff_record WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
      args,
    )
  ).rows;
  const items = (
    await tx.query(
      "SELECT * FROM rms_fulfillment.pickup_handoff_item WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3",
      args,
    )
  ).rows;
  if (operations.length !== records.length) return unavailable();
  let itemCount = 0;
  const effects = operations.map((o) => {
    const effect = decodePickupHandoffRecord(o.record_json),
      r = effect.record;
    const row = records.find((record) => record.pickup_handoff_id === r.handoffReference);
    if (
      !row ||
      r.brandReference !== brand ||
      r.storeReference !== store ||
      r.fulfillmentReference !== fulfillment ||
      effect.operation.operationReference !== o.pickup_handoff_operation_id ||
      effect.operation.idempotencyReference !== o.idempotency_id ||
      effect.operation.correlationReference !== o.correlation_id ||
      effect.operation.aggregateVersionBefore.toString() !== o.aggregate_version_before ||
      effect.operation.aggregateVersionAfter.toString() !== o.aggregate_version_after ||
      effect.operation.phaseBefore !== o.phase_before ||
      effect.operation.phaseAfter !== o.phase_after ||
      r.handoffReference !== o.pickup_handoff_id ||
      r.actorReference !== o.actor_id ||
      r.handedOverAt !== at(o.occurred_at) ||
      r.handedOverAt !== at(row.handed_over_at) ||
      r.pickupLocationReference !== row.pickup_location_id ||
      r.verificationReference !==
        (r.verificationMethod === "InPerson"
          ? row.pickup_in_person_verification_id
          : row.pickup_proof_verification_id) ||
      r.verificationMethod !== row.verification_method ||
      r.recipientType !== row.recipient_type ||
      r.recipientDisplayMask !== row.recipient_display_mask ||
      r.actorReference !== row.actor_id ||
      r.deviceReference !== row.device_id ||
      r.validationStatus !== row.validation_status
    )
      return unavailable();
    const lines = items.filter((line) => line.pickup_handoff_id === r.handoffReference);
    if (lines.length !== effect.items.length) return unavailable();
    for (const line of effect.items) {
      const stored = lines.find((i) => i.fulfillment_item_id === line.fulfillmentItemReference);
      if (
        !stored ||
        stored.handed_over_quantity !== line.quantity ||
        stored.cumulative_handed_over_quantity !== line.cumulativeHandedOverQuantity
      )
        return unavailable();
    }
    itemCount += lines.length;
    return effect;
  });
  if (itemCount !== items.length) return unavailable();
  return effects;
}

/** WP-2423: in-person verifications of a fulfillment (staff verified a customer without a proof). */
export async function readPickupInPersonVerifications(
  tx: ConsumerTransaction,
  brand: string,
  store: string,
  fulfillment: string,
) {
  const rows = (
    await tx.query(
      "SELECT * FROM rms_fulfillment.pickup_in_person_verification WHERE brand_id=$1 AND store_id=$2 AND fulfillment_id=$3 ORDER BY verified_at",
      [brand, store, fulfillment],
    )
  ).rows;
  return rows.map((row) => {
    if (row.brand_id !== brand || row.store_id !== store || row.fulfillment_id !== fulfillment)
      return unavailable();
    return parsePickupInPersonVerificationRecord({
      verificationReference: row.pickup_in_person_verification_id,
      correlationReference: row.correlation_id,
      fulfillmentReference: row.fulfillment_id,
      brandReference: row.brand_id,
      storeReference: row.store_id,
      verificationMethod: "InPerson",
      identityCheck: row.identity_check,
      reason: row.reason,
      verifiedByActorReference: row.verified_by_actor_id,
      verifiedAt: at(row.verified_at),
    });
  });
}

/**
 * WP-2423: which of the given Orders of the Store were closed as not collected at pickup (for the
 * operations order queue). Caller authorizes and owns the transaction.
 */
export async function listStoreUncollectedPickupOrders(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  orderReferences: readonly string[],
): Promise<ReadonlySet<string>> {
  if (orderReferences.length === 0) return new Set();
  if (orderReferences.length > 100) return unavailable();
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
  const rows = (
    await tx.query(
      "SELECT f.order_id::text order_id FROM rms_fulfillment.pickup_not_collected_record n " +
        "JOIN rms_fulfillment.fulfillment f ON f.brand_id=n.brand_id AND f.store_id=n.store_id AND f.fulfillment_id=n.fulfillment_id " +
        "WHERE n.brand_id=$1 AND n.store_id=$2 AND f.order_id=ANY($3::uuid[])",
      [scope.brandReference, scope.storeReference, orderReferences],
    )
  ).rows;
  return new Set(rows.map((row) => String(row.order_id)));
}
