import type { ConsumerTransaction } from "@bop/eventing";
import { PickupHandoffError } from "../../contracts/pickup-handoff.js";
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
      r.verificationReference !== row.pickup_proof_verification_id ||
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
