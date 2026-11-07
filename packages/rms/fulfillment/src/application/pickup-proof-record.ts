import {
  parsePickupProofIssueEffect,
  parsePickupProofVerificationRecord,
  PickupProofError,
} from "../contracts/pickup-proof.js";

function unavailable(): never {
  throw new PickupProofError("PICKUP_PROOF_UNAVAILABLE");
}
export function encodePickupProofIssueRecord(value: unknown): string {
  const effect = parsePickupProofIssueEffect(value);
  return JSON.stringify({ recordVersion: 1, effect }, (_key, entry) =>
    typeof entry === "bigint" ? String(entry) : entry,
  );
}
export function decodePickupProofIssueRecord(value: unknown) {
  try {
    const effect = decodeEnvelope(value);
    for (const key of ["aggregateVersionBefore", "aggregateVersionAfter"]) {
      const version = effect?.operation?.[key];
      if (
        typeof version !== "string" ||
        !/^[1-9][0-9]{0,18}$/.test(version) ||
        BigInt(version) > 9223372036854775807n
      )
        return unavailable();
      effect.operation[key] = BigInt(version);
    }
    return parsePickupProofIssueEffect(effect);
  } catch {
    return unavailable();
  }
}
export function encodePickupProofVerificationRecord(value: unknown): string {
  return JSON.stringify({ recordVersion: 1, effect: parsePickupProofVerificationRecord(value) });
}
export function decodePickupProofVerificationRecord(value: unknown) {
  try {
    return parsePickupProofVerificationRecord(decodeEnvelope(value));
  } catch {
    return unavailable();
  }
}
function decodeEnvelope(value: unknown) {
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
  return record.effect;
}
