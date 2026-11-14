import {
  canonicalFulfillmentValue,
  createPickupFulfillmentSemanticBinding,
  parsePickupFulfillmentCreationEffect,
  PickupFulfillmentError,
} from "../contracts/pickup-fulfillment.js";

function unavailable(): never {
  throw new PickupFulfillmentError("PICKUP_FULFILLMENT_DEPENDENCY_UNAVAILABLE");
}

export function validatePickupFulfillmentRecordEffect(
  value: unknown,
  sha256: (value: string) => string,
) {
  try {
    const effect = parsePickupFulfillmentCreationEffect(value);
    if (
      sha256(
        canonicalFulfillmentValue({
          aggregate: effect.aggregate,
          operation: effect.operation,
          audit: effect.audit,
        }),
      ) !== effect.effectDigest ||
      sha256(createPickupFulfillmentSemanticBinding(effect.aggregate)) !==
        effect.operation.semanticBindingDigest
    )
      return unavailable();
    return effect;
  } catch {
    return unavailable();
  }
}

export function encodePickupFulfillmentRecord(
  value: unknown,
  sha256: (value: string) => string,
): string {
  const effect = validatePickupFulfillmentRecordEffect(value, sha256);
  return JSON.stringify({ recordVersion: 1, effect }, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}

export function decodePickupFulfillmentRecord(value: unknown, sha256: (value: string) => string) {
  try {
    if (typeof value !== "string") return unavailable();
    const record = JSON.parse(value);
    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 2 ||
      record.recordVersion !== 1 ||
      !Object.hasOwn(record, "effect")
    )
      return unavailable();
    const version = record.effect?.aggregate?.sourceAggregateVersion;
    if (
      typeof version !== "string" ||
      !/^[1-9][0-9]{0,18}$/.test(version) ||
      BigInt(version) > 9223372036854775807n
    )
      return unavailable();
    record.effect.aggregate.sourceAggregateVersion = BigInt(version);
    return validatePickupFulfillmentRecordEffect(record.effect, sha256);
  } catch {
    return unavailable();
  }
}
