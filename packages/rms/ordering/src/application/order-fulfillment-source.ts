import {
  OrderFulfillmentSourceError,
  type ConfirmedOrderFulfillmentSourceEvidence,
  type ConfirmedOrderFulfillmentSourceItem,
  type OrderFulfillmentSourceQueryPorts,
  type ResolveConfirmedOrderFulfillmentSourceInput,
} from "../contracts/order-fulfillment-source.js";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";

function fail(code: ConstructorParameters<typeof OrderFulfillmentSourceError>[0]): never {
  throw new OrderFulfillmentSourceError(code);
}

function invalid(): never {
  return fail("ORDER_FULFILLMENT_SOURCE_INPUT_INVALID");
}

function conflict(): never {
  return fail("ORDER_FULFILLMENT_SOURCE_CONFLICT");
}

function dependency(): never {
  return fail("ORDER_FULFILLMENT_SOURCE_DEPENDENCY_UNAVAILABLE");
}

function reference(value: unknown) {
  try {
    return parseOrderingReference(value);
  } catch {
    return invalid();
  }
}

function hash(value: unknown) {
  try {
    return parseOrderingHash(value);
  } catch {
    return invalid();
  }
}

function instant(value: unknown) {
  try {
    return parseOrderingInstant(value);
  } catch {
    return invalid();
  }
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof OrderFulfillmentSourceError) throw error;
    return invalid();
  }
}

function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = descriptors["length"] as PropertyDescriptor | undefined;
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 100) return invalid();
  const keys = Reflect.ownKeys(descriptors);
  const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (
    keys.length !== expected.size ||
    keys.some((key) => typeof key !== "string" || !expected.has(key))
  )
    return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    )
      return invalid();
    result.push(descriptor.value);
  }
  return Object.freeze(result);
}

function positiveInteger(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function item(value: unknown): ConfirmedOrderFulfillmentSourceItem {
  const raw = exact(value, ["orderItemReference", "ordinal", "quantity", "lineDigest"]);
  return Object.freeze({
    orderItemReference: reference(raw.orderItemReference),
    ordinal: positiveInteger(raw.ordinal, 100),
    quantity: positiveInteger(raw.quantity, 999),
    lineDigest: hash(raw.lineDigest),
  });
}

export function parseConfirmedOrderFulfillmentSourceEvidence(
  value: unknown,
): ConfirmedOrderFulfillmentSourceEvidence {
  const raw = exact(value, [
    "evidenceReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEventReference",
    "sourceAggregateVersion",
    "sourceSnapshotDigest",
    "orderType",
    "capturedAt",
    "evidenceVersion",
    "items",
    "evidenceDigest",
  ]);
  if (
    typeof raw.sourceAggregateVersion !== "bigint" ||
    raw.sourceAggregateVersion < 1n ||
    (raw.orderType !== "DineIn" && raw.orderType !== "Pickup") ||
    raw.evidenceVersion !== 1
  )
    return invalid();
  const items = array(raw.items)
    .map(item)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (
    items.some((entry, index) => entry.ordinal !== index + 1) ||
    new Set(items.map((entry) => entry.orderItemReference)).size !== items.length
  )
    return invalid();
  return Object.freeze({
    evidenceReference: reference(raw.evidenceReference),
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    orderReference: reference(raw.orderReference),
    orderBatchReference: reference(raw.orderBatchReference),
    confirmationReference: reference(raw.confirmationReference),
    sourceEventReference: reference(raw.sourceEventReference),
    sourceAggregateVersion: raw.sourceAggregateVersion,
    sourceSnapshotDigest: hash(raw.sourceSnapshotDigest),
    orderType: raw.orderType,
    capturedAt: instant(raw.capturedAt),
    evidenceVersion: 1,
    items: Object.freeze(items),
    evidenceDigest: hash(raw.evidenceDigest),
  });
}

export function createOrderFulfillmentSourceLineBinding(value: unknown): string {
  const parsed = item(value);
  return JSON.stringify({
    orderItemReference: parsed.orderItemReference,
    ordinal: parsed.ordinal,
    quantity: parsed.quantity,
  });
}

export function createOrderFulfillmentSourceEvidenceBinding(value: unknown): string {
  const parsed = parseConfirmedOrderFulfillmentSourceEvidence(value);
  return JSON.stringify({
    evidenceReference: parsed.evidenceReference,
    brandReference: parsed.brandReference,
    storeReference: parsed.storeReference,
    orderReference: parsed.orderReference,
    orderBatchReference: parsed.orderBatchReference,
    confirmationReference: parsed.confirmationReference,
    sourceEventReference: parsed.sourceEventReference,
    sourceAggregateVersion: String(parsed.sourceAggregateVersion),
    sourceSnapshotDigest: parsed.sourceSnapshotDigest,
    orderType: parsed.orderType,
    capturedAt: parsed.capturedAt,
    evidenceVersion: parsed.evidenceVersion,
    items: parsed.items.map((entry) => ({
      orderItemReference: entry.orderItemReference,
      ordinal: entry.ordinal,
      quantity: entry.quantity,
      lineDigest: entry.lineDigest,
    })),
  });
}

function parseInput(value: unknown): ResolveConfirmedOrderFulfillmentSourceInput {
  const raw = exact(value, [
    "brandReference",
    "storeReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "sourceEventReference",
    "sourceAggregateVersion",
    "sourceSnapshotDigest",
    "observedAt",
  ]);
  if (typeof raw.sourceAggregateVersion !== "bigint" || raw.sourceAggregateVersion < 1n)
    return invalid();
  return Object.freeze({
    brandReference: reference(raw.brandReference),
    storeReference: reference(raw.storeReference),
    orderReference: reference(raw.orderReference),
    orderBatchReference: reference(raw.orderBatchReference),
    confirmationReference: reference(raw.confirmationReference),
    sourceEventReference: reference(raw.sourceEventReference),
    sourceAggregateVersion: raw.sourceAggregateVersion,
    sourceSnapshotDigest: hash(raw.sourceSnapshotDigest),
    observedAt: instant(raw.observedAt),
  });
}

export function createOrderFulfillmentSourceQueryService(ports: OrderFulfillmentSourceQueryPorts) {
  return Object.freeze({
    async resolve(value: ResolveConfirmedOrderFulfillmentSourceInput) {
      const input = parseInput(value);
      let authorized: boolean;
      try {
        authorized = await ports.authorization.authorize({
          ...input,
          action: "ResolveConfirmedOrderFulfillmentSource",
          purpose: "CreatePickupFulfillment",
        });
      } catch {
        return dependency();
      }
      if (!authorized) return fail("ORDER_FULFILLMENT_SOURCE_PERMISSION_DENIED");
      let loaded: unknown | null;
      try {
        loaded = await ports.source.loadExact(input);
      } catch {
        return dependency();
      }
      if (loaded === null) return conflict();
      let evidence: ConfirmedOrderFulfillmentSourceEvidence;
      try {
        evidence = parseConfirmedOrderFulfillmentSourceEvidence(loaded);
      } catch {
        return conflict();
      }
      if (
        evidence.brandReference !== input.brandReference ||
        evidence.storeReference !== input.storeReference ||
        evidence.orderReference !== input.orderReference ||
        evidence.orderBatchReference !== input.orderBatchReference ||
        evidence.confirmationReference !== input.confirmationReference ||
        evidence.sourceEventReference !== input.sourceEventReference ||
        evidence.sourceAggregateVersion !== input.sourceAggregateVersion ||
        evidence.sourceSnapshotDigest !== input.sourceSnapshotDigest ||
        Date.parse(evidence.capturedAt) > Date.parse(input.observedAt)
      )
        return conflict();
      try {
        if (
          evidence.items.some(
            (entry) =>
              parseOrderingHash(
                ports.digests.sha256(createOrderFulfillmentSourceLineBinding(entry)),
              ) !== entry.lineDigest,
          ) ||
          parseOrderingHash(
            ports.digests.sha256(createOrderFulfillmentSourceEvidenceBinding(evidence)),
          ) !== evidence.evidenceDigest
        )
          return conflict();
      } catch {
        return dependency();
      }
      return evidence;
    },
  });
}
