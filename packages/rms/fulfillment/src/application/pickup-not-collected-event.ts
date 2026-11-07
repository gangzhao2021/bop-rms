import {
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
  type JsonObject,
} from "@bop/eventing";
import { PickupHandoffError } from "../domain/pickup-handoff.js";
import { parsePickupProofInstant, parsePickupProofReference } from "../domain/pickup-proof.js";

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: Fulfillment publishes a ready pickup closed as not collected,
 * so Ordering can give the Order its terminal outcome. References and times only: no actor, no
 * customer data, no refund (a refund remains an ordinary refund).
 */
export const pickupNotCollectedEventType = "PickupNotCollected" as const;

export interface PickupNotCollectedPayload extends JsonObject {
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly notCollectedReference: string;
  readonly storeReference: string;
  readonly readyAt: string;
  readonly closedAt: string;
}

export type PickupNotCollectedEnvelope = DomainEventEnvelope<PickupNotCollectedPayload> & {
  readonly eventType: typeof pickupNotCollectedEventType;
  readonly schemaVersion: 1;
  readonly producerModule: "@rms/fulfillment";
  readonly aggregateType: "Fulfillment";
  readonly redactionClassification: "indirect_identifier";
};

const invalid = (): never => {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
};

/** Builds the event for one recorded closure (the closure record is the source of truth). */
export function createPickupNotCollectedEvent(input: {
  readonly eventReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly fulfillmentReference: string;
  readonly orderReference: string;
  readonly notCollectedReference: string;
  readonly correlationReference: string;
  readonly aggregateVersionBefore: bigint;
  readonly readyAt: string;
  readonly closedAt: string;
}): PickupNotCollectedEnvelope {
  try {
    return build(input);
  } catch (error) {
    if (error instanceof PickupHandoffError) throw error;
    return invalid();
  }
}

function build(
  input: Parameters<typeof createPickupNotCollectedEvent>[0],
): PickupNotCollectedEnvelope {
  const identities = [
    parsePickupProofReference(input.eventReference),
    parsePickupProofReference(input.fulfillmentReference),
    parsePickupProofReference(input.orderReference),
    parsePickupProofReference(input.notCollectedReference),
  ];
  if (new Set(identities).size !== identities.length) return invalid();
  if (
    typeof input.aggregateVersionBefore !== "bigint" ||
    input.aggregateVersionBefore < 1n ||
    input.aggregateVersionBefore >= 9_223_372_036_854_775_807n
  )
    return invalid();
  const closedAt = parsePickupProofInstant(input.closedAt);
  const readyAt = parsePickupProofInstant(input.readyAt);
  if (readyAt > closedAt) return invalid();
  const storeReference = parsePickupProofReference(input.storeReference);
  const envelope = Object.freeze({
    eventId: identities[0] as string,
    eventType: pickupNotCollectedEventType,
    schemaVersion: 1 as const,
    occurredAt: closedAt,
    producerModule: "@rms/fulfillment" as const,
    tenantId: parsePickupProofReference(input.brandReference),
    storeId: storeReference,
    aggregateType: "Fulfillment" as const,
    aggregateId: identities[1] as string,
    aggregateVersion: input.aggregateVersionBefore + 1n,
    correlationId: parsePickupProofReference(input.correlationReference),
    causationId: identities[3] as string,
    actor: Object.freeze({ type: "System" as const }),
    payload: Object.freeze({
      fulfillmentReference: identities[1] as string,
      orderReference: identities[2] as string,
      notCollectedReference: identities[3] as string,
      storeReference,
      readyAt,
      closedAt,
    }),
    redactionClassification: "indirect_identifier" as const,
    replayMetadata: Object.freeze({ replaySafe: true as const }),
  });
  validateDomainEventEnvelope(envelope);
  return envelope;
}
