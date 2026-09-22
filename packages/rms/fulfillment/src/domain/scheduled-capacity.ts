import {
  parseFulfillmentDigest,
  parseFulfillmentInstant,
  parseFulfillmentReference,
  type FulfillmentDigest,
  type FulfillmentInstant,
  type FulfillmentReference,
} from "./pickup-fulfillment.js";

export type ScheduledCapacityErrorCode =
  | "CAPACITY_INPUT_INVALID"
  | "CAPACITY_DEPENDENCY_UNAVAILABLE"
  | "CAPACITY_IDEMPOTENCY_CONFLICT"
  | "CAPACITY_SCOPE_MISMATCH"
  | "CAPACITY_VERSION_CONFLICT"
  | "CAPACITY_TRANSITION_CONFLICT"
  | "CAPACITY_INSUFFICIENT";

export class ScheduledCapacityError extends Error {
  constructor(readonly code: ScheduledCapacityErrorCode) {
    super("scheduled capacity is unavailable");
    this.name = "ScheduledCapacityError";
  }
}

export interface ScheduledCapacitySlot {
  readonly brandReference: FulfillmentReference;
  readonly storeReference: FulfillmentReference;
  readonly fulfillmentType: "Pickup" | "Delivery";
  readonly slotReference: FulfillmentReference;
  readonly configVersion: number;
  readonly startsAt: FulfillmentInstant;
  readonly endsAt: FulfillmentInstant;
}

interface CapacityProvenance {
  readonly slot: ScheduledCapacitySlot;
  readonly holdReference: FulfillmentReference;
  readonly cartReference: FulfillmentReference;
  readonly operationReference: FulfillmentReference;
  readonly units: number;
  readonly unitsRuleVersion: number;
  readonly unitsInputDigest: FulfillmentDigest;
}

export interface ScheduledCapacityHold extends CapacityProvenance {
  readonly state: "Active" | "Converted" | "Released" | "Expired";
  readonly version: number;
  readonly createdAt: FulfillmentInstant;
  readonly updatedAt: FulfillmentInstant;
  readonly expiresAt: FulfillmentInstant;
  readonly allocationReference: FulfillmentReference | null;
}

export interface ScheduledCapacityAllocation extends CapacityProvenance {
  readonly allocationReference: FulfillmentReference;
  readonly orderReference: FulfillmentReference;
  readonly fulfillmentReference: FulfillmentReference;
  readonly state: "Active" | "Consumed" | "Released";
  readonly consumedAt: FulfillmentInstant | null;
  readonly version: number;
  readonly createdAt: FulfillmentInstant;
  readonly updatedAt: FulfillmentInstant;
}

function fail(code: ScheduledCapacityErrorCode = "CAPACITY_INPUT_INVALID"): never {
  throw new ScheduledCapacityError(code);
}

function capture<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof ScheduledCapacityError) throw error;
    return fail();
  }
}

function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return fail();
    result[field] = descriptor.value;
  }
  return result;
}

function integer(value: unknown, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) return fail();
  return value;
}

export function parseScheduledCapacitySlot(value: unknown): ScheduledCapacitySlot {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "fulfillmentType",
    "slotReference",
    "configVersion",
    "startsAt",
    "endsAt",
  ]);
  const startsAt = parseFulfillmentInstant(raw.startsAt);
  const endsAt = parseFulfillmentInstant(raw.endsAt);
  if (
    startsAt >= endsAt ||
    (raw.fulfillmentType !== "Pickup" && raw.fulfillmentType !== "Delivery")
  )
    return fail();
  return Object.freeze({
    brandReference: parseFulfillmentReference(raw.brandReference),
    storeReference: parseFulfillmentReference(raw.storeReference),
    fulfillmentType: raw.fulfillmentType,
    slotReference: parseFulfillmentReference(raw.slotReference),
    configVersion: integer(raw.configVersion),
    startsAt,
    endsAt,
  });
}

const provenanceFields = [
  "slot",
  "holdReference",
  "cartReference",
  "operationReference",
  "units",
  "unitsRuleVersion",
  "unitsInputDigest",
] as const;

function provenance(raw: Record<string, unknown>): CapacityProvenance {
  return {
    slot: parseScheduledCapacitySlot(raw.slot),
    holdReference: parseFulfillmentReference(raw.holdReference),
    cartReference: parseFulfillmentReference(raw.cartReference),
    operationReference: parseFulfillmentReference(raw.operationReference),
    units: integer(raw.units),
    unitsRuleVersion: integer(raw.unitsRuleVersion),
    unitsInputDigest: parseFulfillmentDigest(raw.unitsInputDigest),
  };
}

export function parseScheduledCapacityHold(value: unknown): ScheduledCapacityHold {
  return capture(() => {
    const raw = exact(value, [
      ...provenanceFields,
      "state",
      "version",
      "createdAt",
      "updatedAt",
      "expiresAt",
      "allocationReference",
    ]);
    const base = provenance(raw);
    const createdAt = parseFulfillmentInstant(raw.createdAt);
    const updatedAt = parseFulfillmentInstant(raw.updatedAt);
    const expiresAt = parseFulfillmentInstant(raw.expiresAt);
    const version = integer(raw.version);
    const allocationReference =
      raw.allocationReference === null ? null : parseFulfillmentReference(raw.allocationReference);
    if (
      createdAt >= expiresAt ||
      createdAt >= base.slot.startsAt ||
      updatedAt < createdAt ||
      !["Active", "Converted", "Released", "Expired"].includes(raw.state as string) ||
      (raw.state === "Active" ? version !== 1 || updatedAt !== createdAt : version !== 2) ||
      (raw.state === "Converted" ? allocationReference === null : allocationReference !== null) ||
      ((raw.state === "Converted" || raw.state === "Released") && updatedAt >= expiresAt) ||
      (raw.state === "Converted" && updatedAt >= base.slot.startsAt) ||
      (raw.state === "Expired" && updatedAt < expiresAt)
    )
      return fail();
    return Object.freeze({
      ...base,
      state: raw.state as ScheduledCapacityHold["state"],
      version,
      createdAt,
      updatedAt,
      expiresAt,
      allocationReference,
    });
  });
}

export function parseScheduledCapacityAllocation(value: unknown): ScheduledCapacityAllocation {
  return capture(() => {
    const raw = exact(value, [
      ...provenanceFields,
      "allocationReference",
      "orderReference",
      "fulfillmentReference",
      "state",
      "version",
      "createdAt",
      "updatedAt",
      "consumedAt",
    ]);
    const base = provenance(raw);
    const createdAt = parseFulfillmentInstant(raw.createdAt);
    const updatedAt = parseFulfillmentInstant(raw.updatedAt);
    const version = integer(raw.version);
    const consumedAt = raw.consumedAt === null ? null : parseFulfillmentInstant(raw.consumedAt);
    if (
      createdAt >= base.slot.startsAt ||
      updatedAt < createdAt ||
      !["Active", "Consumed", "Released"].includes(raw.state as string) ||
      (raw.state === "Active" ? version !== 1 || updatedAt !== createdAt : version !== 2) ||
      (raw.state === "Consumed"
        ? consumedAt === null ||
          consumedAt < createdAt ||
          consumedAt > updatedAt ||
          consumedAt > base.slot.startsAt
        : consumedAt !== null) ||
      (raw.state === "Released" && updatedAt >= base.slot.startsAt)
    )
      return fail();
    return Object.freeze({
      ...base,
      allocationReference: parseFulfillmentReference(raw.allocationReference),
      orderReference: parseFulfillmentReference(raw.orderReference),
      fulfillmentReference: parseFulfillmentReference(raw.fulfillmentReference),
      state: raw.state as ScheduledCapacityAllocation["state"],
      version,
      createdAt,
      updatedAt,
      consumedAt,
    });
  });
}

function guard(
  raw: Record<string, unknown>,
  aggregate: ScheduledCapacityHold | ScheduledCapacityAllocation,
): FulfillmentInstant {
  const scope = exact(raw.scope, ["brandReference", "storeReference"]);
  const brand = parseFulfillmentReference(scope.brandReference);
  const store = parseFulfillmentReference(scope.storeReference);
  if (brand !== aggregate.slot.brandReference || store !== aggregate.slot.storeReference)
    return fail("CAPACITY_SCOPE_MISMATCH");
  if (integer(raw.expectedVersion) !== aggregate.version) return fail("CAPACITY_VERSION_CONFLICT");
  const at = parseFulfillmentInstant(raw.at);
  if (at < aggregate.updatedAt || aggregate.state !== "Active")
    return fail("CAPACITY_TRANSITION_CONFLICT");
  return at;
}

/** A pure admission calculation. The owner transaction must lock and account for the actual slot. */
export function requireScheduledCapacityUnits(value: unknown): number {
  return capture(() => {
    const raw = exact(value, ["limit", "occupied", "requested"]);
    const limit = integer(raw.limit, 0);
    const occupied = integer(raw.occupied, 0);
    const requested = integer(raw.requested);
    // Subtraction avoids overflowing when existing occupancy plus requested units is unsafe.
    if (occupied > limit || requested > limit - occupied) return fail("CAPACITY_INSUFFICIENT");
    return requested;
  });
}

/** Persist both returned facts and their history atomically; this proposal reserves nothing. */
export function planScheduledCapacityConversion(value: unknown): {
  readonly hold: ScheduledCapacityHold;
  readonly allocation: ScheduledCapacityAllocation;
  readonly occupancyDelta: 0;
} {
  return capture(() => {
    const raw = exact(value, [
      "hold",
      "scope",
      "expectedVersion",
      "at",
      "allocationReference",
      "orderReference",
      "fulfillmentReference",
    ]);
    const hold = parseScheduledCapacityHold(raw.hold);
    const at = guard(raw, hold);
    if (at >= hold.expiresAt || at >= hold.slot.startsAt)
      return fail("CAPACITY_TRANSITION_CONFLICT");
    const allocationReference = parseFulfillmentReference(raw.allocationReference);
    const nextHold = parseScheduledCapacityHold({
      ...hold,
      state: "Converted",
      version: 2,
      updatedAt: at,
      allocationReference,
    });
    const allocation = parseScheduledCapacityAllocation({
      slot: hold.slot,
      holdReference: hold.holdReference,
      cartReference: hold.cartReference,
      operationReference: hold.operationReference,
      units: hold.units,
      unitsRuleVersion: hold.unitsRuleVersion,
      unitsInputDigest: hold.unitsInputDigest,
      allocationReference,
      orderReference: raw.orderReference,
      fulfillmentReference: raw.fulfillmentReference,
      state: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
      consumedAt: null,
    });
    return Object.freeze({ hold: nextHold, allocation, occupancyDelta: 0 });
  });
}

export function planScheduledCapacityHoldRelease(value: unknown): {
  readonly hold: ScheduledCapacityHold;
  readonly occupancyDelta: number;
} {
  return capture(() => {
    const raw = exact(value, ["hold", "scope", "expectedVersion", "at", "reason"]);
    const hold = parseScheduledCapacityHold(raw.hold);
    const at = guard(raw, hold);
    if (raw.reason !== "Release" && raw.reason !== "Expire") return fail();
    if (raw.reason === "Expire" && at < hold.expiresAt) return fail("CAPACITY_TRANSITION_CONFLICT");
    const next = parseScheduledCapacityHold({
      ...hold,
      state: at >= hold.expiresAt ? "Expired" : "Released",
      version: 2,
      updatedAt: at,
    });
    return Object.freeze({ hold: next, occupancyDelta: -hold.units });
  });
}

/** InProgress evidence must come from the authorized owner; null never disproves known progress. */
export function planScheduledCapacityAllocationTransition(value: unknown): {
  readonly allocation: ScheduledCapacityAllocation;
  readonly occupancyDelta: number;
} {
  return capture(() => {
    const raw = exact(value, [
      "allocation",
      "scope",
      "expectedVersion",
      "at",
      "action",
      "fulfillmentInProgressAt",
    ]);
    const allocation = parseScheduledCapacityAllocation(raw.allocation);
    const at = guard(raw, allocation);
    if (raw.action !== "Release" && raw.action !== "Consume") return fail();
    const inProgressAt =
      raw.fulfillmentInProgressAt === null
        ? null
        : parseFulfillmentInstant(raw.fulfillmentInProgressAt);
    if (inProgressAt !== null && (inProgressAt < allocation.createdAt || inProgressAt > at))
      return fail();
    const consumed = at >= allocation.slot.startsAt || inProgressAt !== null;
    if (raw.action === "Consume" && !consumed) return fail("CAPACITY_TRANSITION_CONFLICT");
    const next = parseScheduledCapacityAllocation({
      ...allocation,
      state: consumed ? "Consumed" : "Released",
      version: 2,
      updatedAt: at,
      consumedAt: consumed
        ? inProgressAt !== null && inProgressAt < allocation.slot.startsAt
          ? inProgressAt
          : allocation.slot.startsAt
        : null,
    });
    return Object.freeze({ allocation: next, occupancyDelta: consumed ? 0 : -allocation.units });
  });
}
