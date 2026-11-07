import { PickupHandoffError, type PickupHandoffSource } from "./pickup-handoff.js";

/**
 * WP-2423: a ready pickup order that nobody collected is closed as not collected by an authorized
 * staff member once the pickup hold has passed (one hour after it was ready) and no valid pickup
 * code remains. It is not refunded here; a refund, when granted, is an ordinary refund.
 */
export const pickupHoldMilliseconds = 60 * 60 * 1000;

export interface PickupNotCollectedRecord {
  readonly notCollectedReference: string;
  readonly fulfillmentReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly reason: "NotCollected";
  readonly readyAt: string;
  readonly closedAt: string;
  readonly idempotencyReference: string;
  readonly correlationReference: string;
  readonly aggregateVersionBefore: bigint;
}

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const fail = (code: PickupHandoffError["code"]): never => {
  throw new PickupHandoffError(code);
};
const reference = (value: unknown): string =>
  typeof value === "string" && referencePattern.test(value)
    ? value
    : fail("PICKUP_HANDOFF_INPUT_INVALID");
const instant = (value: unknown): string =>
  typeof value === "string" &&
  instantPattern.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value
    ? value
    : fail("PICKUP_HANDOFF_INPUT_INVALID");

/** Plans the closure against the locked current pickup state. */
export function planPickupNotCollected(input: {
  readonly source: PickupHandoffSource;
  readonly readyAt: string;
  /** When the current pickup code expires, or null when none was issued. */
  readonly proofExpiresAt: string | null;
  readonly alreadyClosed: boolean;
  readonly expectedAggregateVersion: bigint;
  readonly actorReference: string;
  readonly notCollectedReference: string;
  readonly idempotencyReference: string;
  readonly correlationReference: string;
  readonly closedAt: string;
}): PickupNotCollectedRecord {
  const source = input.source;
  if (input.alreadyClosed) return fail("PICKUP_HANDOFF_ALREADY_COMPLETED");
  if (source.canonicalPhase === "Completed") return fail("PICKUP_HANDOFF_ALREADY_COMPLETED");
  if (source.canonicalPhase !== "Ready" && source.canonicalPhase !== "InProgress")
    return fail("PICKUP_HANDOFF_NOT_READY");
  if (input.expectedAggregateVersion !== source.aggregateVersion)
    return fail("PICKUP_HANDOFF_VERSION_CONFLICT");
  const readyAt = instant(input.readyAt),
    closedAt = instant(input.closedAt);
  if (
    closedAt > source.lockedAt ||
    Date.parse(closedAt) < Date.parse(readyAt) + pickupHoldMilliseconds ||
    (input.proofExpiresAt !== null && instant(input.proofExpiresAt) > closedAt)
  )
    return fail("PICKUP_HANDOFF_NOT_READY");
  const references = [
    reference(input.notCollectedReference),
    reference(input.idempotencyReference),
    reference(input.correlationReference),
  ];
  if (new Set(references).size !== references.length) return fail("PICKUP_HANDOFF_INPUT_INVALID");
  return Object.freeze({
    notCollectedReference: references[0] as string,
    fulfillmentReference: source.fulfillmentReference,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    actorReference: reference(input.actorReference),
    reason: "NotCollected",
    readyAt,
    closedAt,
    idempotencyReference: references[1] as string,
    correlationReference: references[2] as string,
    aggregateVersionBefore: source.aggregateVersion,
  });
}
