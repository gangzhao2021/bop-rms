import { parsePickupProofCapability } from "@bop/public-capability";
import type { FulfillmentReadinessSource } from "../contracts/fulfillment-readiness.js";
import {
  parsePickupProofSource,
  planPickupProofIssue,
  PickupProofError,
  type PickupProofGenerationRecord,
  type PickupProofIssueEffect,
  type PickupProofVerificationRecord,
} from "../contracts/pickup-proof.js";
import { encodePickupProofIssueRecord } from "./pickup-proof-record.js";

function unavailable(): never {
  throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
}
export function pickupProofCapabilityFromGeneration(g: PickupProofGenerationRecord) {
  return parsePickupProofCapability({
    capabilityReference: g.capabilityReference,
    purpose: "PickupHandoff",
    kind: g.kind,
    storeReference: g.storeReference,
    fulfillmentReference: g.fulfillmentReference,
    publicOrderReference: g.publicOrderReference,
    selectorHash: g.selectorHash,
    pepperVersion: g.pepperVersion,
    generation: g.generation,
    status: "Active",
    version: 1,
    readyAt: g.readyAt,
    expiresAt: g.expiresAt,
    revokedAt: null,
  });
}
/** Folds original Ready and append-only proof facts; never moves the original expiry window. */
export function foldPickupProofHistory(
  readiness: FulfillmentReadinessSource,
  readyAt: string,
  history: {
    readonly issues: readonly PickupProofIssueEffect[];
    readonly verifications: readonly PickupProofVerificationRecord[];
  },
) {
  let source = parsePickupProofSource({
    fulfillmentReference: readiness.fulfillmentReference,
    brandReference: readiness.brandReference,
    storeReference: readiness.storeReference,
    fulfillmentType: "Pickup",
    canonicalPhase: readiness.canonicalPhase,
    aggregateVersion: readiness.aggregateVersion,
    readyAt,
    currentProofGeneration: null,
    currentProofCapabilityReference: null,
    lockedAt: readiness.lockedAt,
    items: readiness.items.map(
      ({
        fulfillmentItemReference,
        orderedQuantity,
        readyQuantity,
        handedOverQuantity,
        state,
      }) => ({
        fulfillmentItemReference,
        orderedQuantity,
        readyQuantity,
        handedOverQuantity,
        state,
      }),
    ),
  });
  let previous: ReturnType<typeof pickupProofCapabilityFromGeneration> | null = null;
  let issuedAt = source.readyAt;
  if (source.readyAt > source.lockedAt) return unavailable();
  for (const effect of history.issues) {
    const g = effect.generation,
      o = effect.operation;
    if (g.issuedAt < issuedAt || g.issuedAt > source.lockedAt) return unavailable();
    const candidate = pickupProofCapabilityFromGeneration(g);
    const replayed = planPickupProofIssue({
      source,
      candidate,
      previous,
      expectedAggregateVersion: source.aggregateVersion,
      observedAt: g.issuedAt,
      operationReference: o.operationReference,
      invalidationReference: effect.invalidation?.invalidationReference ?? null,
      idempotencyReference: o.idempotencyReference,
      correlationReference: o.correlationReference,
    });
    if (encodePickupProofIssueRecord(replayed) !== encodePickupProofIssueRecord(effect))
      return unavailable();
    source = parsePickupProofSource({
      ...source,
      aggregateVersion: o.aggregateVersionAfter,
      currentProofGeneration: g.generation,
      currentProofCapabilityReference: g.capabilityReference,
    });
    previous = candidate;
    issuedAt = g.issuedAt;
  }
  for (const v of history.verifications) {
    const g = history.issues.find(
      (e) => e.generation.capabilityReference === v.capabilityReference,
    )?.generation;
    const invalidation = history.issues.find(
      (e) => e.invalidation?.priorCapabilityReference === v.capabilityReference,
    )?.invalidation;
    if (
      !g ||
      v.brandReference !== source.brandReference ||
      v.storeReference !== source.storeReference ||
      v.fulfillmentReference !== source.fulfillmentReference ||
      v.generation !== g.generation ||
      v.verificationMethod !== g.kind ||
      v.verifiedAt < g.issuedAt ||
      v.verifiedAt >= g.expiresAt ||
      v.verifiedAt > source.lockedAt ||
      (invalidation && v.verifiedAt > invalidation.invalidatedAt)
    )
      return unavailable();
  }
  return { source, capability: previous, lastIssuedAt: issuedAt };
}
