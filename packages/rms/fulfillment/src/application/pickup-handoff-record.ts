import { parsePickupHandoffEffect, PickupHandoffError } from "../contracts/pickup-handoff.js";

function unavailable(): never {
  throw new PickupHandoffError("PICKUP_HANDOFF_INPUT_INVALID");
}
export function encodePickupHandoffRecord(value: unknown): string {
  const effect = parsePickupHandoffEffect(value);
  return JSON.stringify({ recordVersion: 1, effect }, (_key, entry) =>
    typeof entry === "bigint" ? String(entry) : entry,
  );
}
function restoreVersion(value: unknown): bigint {
  if (
    typeof value !== "string" ||
    !/^[1-9][0-9]{0,18}$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return unavailable();
  return BigInt(value);
}
export function decodePickupHandoffRecord(value: unknown) {
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
    record.effect.nextAggregateVersion = restoreVersion(record.effect?.nextAggregateVersion);
    for (const key of ["aggregateVersionBefore", "aggregateVersionAfter"]) {
      record.effect.operation[key] = restoreVersion(record.effect?.operation?.[key]);
    }
    return parsePickupHandoffEffect(record.effect);
  } catch {
    return unavailable();
  }
}
