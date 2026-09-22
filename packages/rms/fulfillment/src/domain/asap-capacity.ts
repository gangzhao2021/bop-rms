import {
  parseFulfillmentReference,
  parseFulfillmentDigest,
  parseFulfillmentInstant,
  type FulfillmentReference,
  type FulfillmentDigest,
  type FulfillmentInstant,
} from "./pickup-fulfillment.js";
import { parseScheduledCapacitySlot, type ScheduledCapacitySlot } from "./scheduled-capacity.js";

const referenceKeys = [
  "allocationReference",
  "guestSessionReference",
  "cartReference",
  "quoteReference",
  "submissionReference",
  "orderReference",
  "orderBatchReference",
  "fulfillmentReference",
  "paymentOperationReference",
] as const;
type References = Readonly<Record<(typeof referenceKeys)[number], FulfillmentReference>>;
export interface AsapCapacityCommitment extends References {
  readonly slot: ScheduledCapacitySlot;
  readonly cartVersion: number;
  readonly units: number;
  readonly unitsRuleVersion: number;
  readonly unitsInputDigest: FulfillmentDigest;
  readonly intentDigest: FulfillmentDigest;
  readonly state: "Prepared" | "PaymentPending" | "Released" | "Expired" | "Consumed";
  readonly version: 1 | 2 | 3;
  readonly preparedAt: FulfillmentInstant;
  readonly preparationValidUntil: FulfillmentInstant;
  readonly orderingLinkedAt: FulfillmentInstant | null;
  readonly paymentRequestedAt: FulfillmentInstant | null;
  readonly capacityExpiresAt: FulfillmentInstant | null;
  readonly terminalAt: FulfillmentInstant | null;
}
export class AsapCapacityError extends Error {
  constructor(
    readonly code:
      | "ASAP_CAPACITY_INVALID"
      | "ASAP_CAPACITY_CONFLICT"
      | "ASAP_CAPACITY_INSUFFICIENT"
      | "ASAP_CAPACITY_EXPIRED"
      | "ASAP_CAPACITY_UNAVAILABLE",
  ) {
    super("ASAP capacity is unavailable");
    this.name = "AsapCapacityError";
  }
}
const fail = (code: AsapCapacityError["code"] = "ASAP_CAPACITY_INVALID"): never => {
  throw new AsapCapacityError(code);
};
function capture<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof AsapCapacityError) throw error;
    return fail();
  }
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function integer(value: unknown, minimum = 1): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) return fail();
  return value as number;
}
const nullableTime = (value: unknown) => (value === null ? null : parseFulfillmentInstant(value));
export function parseAsapCapacityCommitment(value: unknown): AsapCapacityCommitment {
  return capture(() => {
    const raw = closed(value, [
      ...referenceKeys,
      "slot",
      "cartVersion",
      "units",
      "unitsRuleVersion",
      "unitsInputDigest",
      "intentDigest",
      "state",
      "version",
      "preparedAt",
      "preparationValidUntil",
      "orderingLinkedAt",
      "paymentRequestedAt",
      "capacityExpiresAt",
      "terminalAt",
    ]);
    const references = Object.fromEntries(
      referenceKeys.map((k) => [k, parseFulfillmentReference(raw[k])]),
    ) as References;
    const slot = parseScheduledCapacitySlot(raw.slot);
    const preparedAt = parseFulfillmentInstant(raw.preparedAt);
    const preparationValidUntil = parseFulfillmentInstant(raw.preparationValidUntil);
    const orderingLinkedAt = nullableTime(raw.orderingLinkedAt);
    const paymentRequestedAt = nullableTime(raw.paymentRequestedAt);
    const capacityExpiresAt = nullableTime(raw.capacityExpiresAt);
    const terminalAt = nullableTime(raw.terminalAt);
    const sealed = paymentRequestedAt !== null;
    const terminal =
      raw.state === "Released" || raw.state === "Expired" || raw.state === "Consumed";
    if (
      slot.fulfillmentType !== "Pickup" ||
      preparedAt >= preparationValidUntil ||
      preparedAt >= slot.endsAt ||
      (!sealed && (orderingLinkedAt !== null || capacityExpiresAt !== null)) ||
      (sealed &&
        (orderingLinkedAt === null ||
          capacityExpiresAt === null ||
          orderingLinkedAt < preparedAt ||
          paymentRequestedAt < orderingLinkedAt ||
          paymentRequestedAt >= preparationValidUntil ||
          Date.parse(capacityExpiresAt) - Date.parse(paymentRequestedAt) !== 30 * 60_000)) ||
      (raw.state === "Prepared" && (sealed || raw.version !== 1 || terminalAt !== null)) ||
      (raw.state === "PaymentPending" && (!sealed || raw.version !== 2 || terminalAt !== null)) ||
      (terminal &&
        (terminalAt === null ||
          terminalAt < (paymentRequestedAt ?? preparedAt) ||
          raw.version !== (sealed ? 3 : 2))) ||
      (!terminal && raw.state !== "Prepared" && raw.state !== "PaymentPending") ||
      (raw.state === "Consumed" &&
        (!sealed ||
          terminalAt === null ||
          capacityExpiresAt === null ||
          terminalAt >= capacityExpiresAt)) ||
      (raw.state === "Expired" &&
        terminalAt !== null &&
        terminalAt < (capacityExpiresAt ?? preparationValidUntil))
    )
      return fail();
    return Object.freeze({
      ...references,
      slot,
      cartVersion: integer(raw.cartVersion),
      units: integer(raw.units),
      unitsRuleVersion: integer(raw.unitsRuleVersion),
      unitsInputDigest: parseFulfillmentDigest(raw.unitsInputDigest),
      intentDigest: parseFulfillmentDigest(raw.intentDigest),
      state: raw.state as AsapCapacityCommitment["state"],
      version: raw.version as AsapCapacityCommitment["version"],
      preparedAt,
      preparationValidUntil,
      orderingLinkedAt,
      paymentRequestedAt,
      capacityExpiresAt,
      terminalAt,
    });
  });
}
export function prepareAsapCapacityCommitment(
  value: unknown,
  currentValue: unknown,
): AsapCapacityCommitment {
  return capture(() => {
    const raw = closed(value, [
      ...referenceKeys,
      "slot",
      "cartVersion",
      "units",
      "unitsRuleVersion",
      "unitsInputDigest",
      "intentDigest",
      "preparedAt",
      "preparationValidUntil",
    ]);
    const record = parseAsapCapacityCommitment({
      ...raw,
      state: "Prepared",
      version: 1,
      orderingLinkedAt: null,
      paymentRequestedAt: null,
      capacityExpiresAt: null,
      terminalAt: null,
    });
    const current = closed(currentValue, ["slot", "capacityLimit", "occupiedUnits", "observedAt"]);
    if (
      JSON.stringify(parseScheduledCapacitySlot(current.slot)) !== JSON.stringify(record.slot) ||
      parseFulfillmentInstant(current.observedAt) < record.preparedAt ||
      parseFulfillmentInstant(current.observedAt) >= record.preparationValidUntil
    )
      return fail("ASAP_CAPACITY_CONFLICT");
    if (
      BigInt(record.units) >
      BigInt(integer(current.capacityLimit, 0)) - BigInt(integer(current.occupiedUnits, 0))
    )
      return fail("ASAP_CAPACITY_INSUFFICIENT");
    return record;
  });
}
export function sealAsapCapacityCommitment(
  value: unknown,
  acknowledgement: unknown,
  requestedAtValue: unknown,
  observedAtValue: unknown,
): AsapCapacityCommitment {
  return capture(() => {
    const record = parseAsapCapacityCommitment(value);
    const ack = closed(acknowledgement, [
      ...referenceKeys,
      "brandReference",
      "storeReference",
      "cartVersion",
      "intentDigest",
      "acknowledgedAt",
    ]);
    const requestedAt = parseFulfillmentInstant(requestedAtValue),
      observedAt = parseFulfillmentInstant(observedAtValue);
    if (record.state !== "Prepared") return fail("ASAP_CAPACITY_CONFLICT");
    if (
      referenceKeys.some((k) => ack[k] !== record[k]) ||
      ack.brandReference !== record.slot.brandReference ||
      ack.storeReference !== record.slot.storeReference ||
      ack.cartVersion !== record.cartVersion ||
      ack.intentDigest !== record.intentDigest
    )
      return fail("ASAP_CAPACITY_CONFLICT");
    if (observedAt < requestedAt || observedAt >= record.preparationValidUntil)
      return fail("ASAP_CAPACITY_EXPIRED");
    return parseAsapCapacityCommitment({
      ...record,
      state: "PaymentPending",
      version: 2,
      orderingLinkedAt: parseFulfillmentInstant(ack.acknowledgedAt),
      paymentRequestedAt: requestedAt,
      capacityExpiresAt: new Date(Date.parse(requestedAt) + 30 * 60_000).toISOString(),
    });
  });
}
/** Caller must establish cancellation/fulfillment authority. Pure transitions do not release a DB slot. */
export function finishAsapCapacityCommitment(
  value: unknown,
  state: "Released" | "Expired" | "Consumed",
  observedAtValue: unknown,
): AsapCapacityCommitment {
  return capture(() => {
    const record = parseAsapCapacityCommitment(value),
      observedAt = parseFulfillmentInstant(observedAtValue);
    if (record.state !== "Prepared" && record.state !== "PaymentPending")
      return fail("ASAP_CAPACITY_CONFLICT");
    if (
      state === "Consumed" &&
      (record.capacityExpiresAt === null || observedAt >= record.capacityExpiresAt)
    )
      return fail("ASAP_CAPACITY_EXPIRED");
    return parseAsapCapacityCommitment({
      ...record,
      state,
      version: record.version + 1,
      terminalAt: observedAt,
    });
  });
}
export function assertAsapCapacityPaymentUsable(
  value: unknown,
  observedAtValue: unknown,
): AsapCapacityCommitment {
  return capture(() => {
    const record = parseAsapCapacityCommitment(value),
      observedAt = parseFulfillmentInstant(observedAtValue);
    if (
      record.state !== "PaymentPending" ||
      record.paymentRequestedAt === null ||
      record.capacityExpiresAt === null ||
      observedAt < record.paymentRequestedAt ||
      observedAt >= record.capacityExpiresAt
    )
      return fail("ASAP_CAPACITY_EXPIRED");
    return record;
  });
}
