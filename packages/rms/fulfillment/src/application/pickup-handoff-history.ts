import {
  parsePickupHandoffSource,
  planCompletePickupHandoff,
  PickupHandoffError,
  type PickupHandoffEffect,
} from "../contracts/pickup-handoff.js";
import type { foldPickupProofHistory } from "./pickup-proof-history.js";
import type { PickupProofVerificationRecord } from "../contracts/pickup-proof.js";
import { encodePickupHandoffRecord } from "./pickup-handoff-record.js";
function unavailable(): never {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
}
/** Historical replay uses the recorded permission; it cannot authorize a new command. */
export function foldPickupHandoffHistory(
  proof: ReturnType<typeof foldPickupProofHistory>,
  verifications: readonly PickupProofVerificationRecord[],
  history: readonly PickupHandoffEffect[],
) {
  if (!proof.capability || proof.source.currentProofGeneration === null) {
    if (history.length) return unavailable();
    return null;
  }
  let source = parsePickupHandoffSource({
    ...proof.source,
    currentProofGeneration: proof.source.currentProofGeneration,
  });
  let lastHandoffAt = proof.lastIssuedAt;
  for (const effect of history) {
    const r = effect.record,
      o = effect.operation,
      a = effect.audit;
    const verification = verifications.find(
      (v) => v.verificationReference === r.verificationReference,
    );
    if (
      !verification ||
      r.handedOverAt < lastHandoffAt ||
      r.handedOverAt > source.lockedAt ||
      String(r.handedOverAt) >= String(proof.capability.expiresAt)
    )
      return unavailable();
    const replayed = planCompletePickupHandoff(source, {
      fulfillmentReference: r.fulfillmentReference,
      brandReference: r.brandReference,
      storeReference: r.storeReference,
      expectedAggregateVersion: o.aggregateVersionBefore,
      purpose: "CompletePickupHandoff",
      actorReference: r.actorReference,
      actorPermissions: [a.permission],
      verification,
      recipientType: r.recipientType,
      recipientDisplayMask: r.recipientDisplayMask,
      pickupLocationReference: r.pickupLocationReference,
      deviceReference: r.deviceReference,
      quantities: effect.items.map((i) => ({
        fulfillmentItemReference: i.fulfillmentItemReference,
        quantity: i.quantity,
      })),
      handoffReference: r.handoffReference,
      operationReference: o.operationReference,
      auditReference: a.auditReference,
      idempotencyReference: o.idempotencyReference,
      correlationReference: o.correlationReference,
      handedOverAt: r.handedOverAt,
    });
    if (encodePickupHandoffRecord(replayed) !== encodePickupHandoffRecord(effect))
      return unavailable();
    source = parsePickupHandoffSource({
      ...source,
      aggregateVersion: effect.nextAggregateVersion,
      canonicalPhase: effect.nextPhase,
      items: source.items.map((item) => {
        const line = effect.items.find(
          (v) => v.fulfillmentItemReference === item.fulfillmentItemReference,
        );
        const handedOverQuantity = line?.cumulativeHandedOverQuantity ?? item.handedOverQuantity;
        return {
          ...item,
          handedOverQuantity,
          state: handedOverQuantity === item.readyQuantity ? "HandedOver" : "Ready",
        };
      }),
    });
    lastHandoffAt = r.handedOverAt;
  }
  return { source, verifications, capability: proof.capability, lastHandoffAt };
}
