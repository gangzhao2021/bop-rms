import {
  canonicalReadinessValue,
  parseFulfillmentReadyEffect,
  FulfillmentReadinessError,
} from "../contracts/fulfillment-readiness.js";
import { createFulfillmentReadySemanticBinding } from "./fulfillment-readiness-service.js";
function unavailable(): never {
  throw new FulfillmentReadinessError("FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE");
}
export function validateFulfillmentReadyRecordEffect(
  value: unknown,
  sha256: (value: string) => string,
) {
  try {
    const effect = parseFulfillmentReadyEffect(value);
    if (
      sha256(
        canonicalReadinessValue({
          result: effect.result,
          operation: effect.operation,
          audit: effect.audit,
        }),
      ) !== effect.effectDigest ||
      sha256(createFulfillmentReadySemanticBinding(effect)) !==
        effect.operation.semanticBindingDigest
    )
      return unavailable();
    return effect;
  } catch {
    return unavailable();
  }
}
export function encodeFulfillmentReadyRecord(value: unknown, sha256: (value: string) => string) {
  const effect = validateFulfillmentReadyRecordEffect(value, sha256);
  return JSON.stringify({ recordVersion: 1, effect }, (_key, entry) =>
    typeof entry === "bigint" ? entry.toString() : entry,
  );
}
export function decodeFulfillmentReadyRecord(value: unknown, sha256: (value: string) => string) {
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
    for (const key of ["aggregateVersionBefore", "aggregateVersionAfter"]) {
      const version = record.effect?.operation?.[key];
      if (
        typeof version !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(version) ||
        BigInt(version) > 9223372036854775807n
      )
        return unavailable();
      record.effect.operation[key] = BigInt(version);
    }
    return validateFulfillmentReadyRecordEffect(record.effect, sha256);
  } catch {
    return unavailable();
  }
}
