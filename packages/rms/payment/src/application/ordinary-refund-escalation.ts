import { exactPaymentObject, parsePaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";

export const ordinaryRefundPolicyVersion = "PILOT_ORDINARY_REFUND_V1" as const;
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_POLICY_INPUT_INVALID");
};
const scopeKeys = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
] as const;
function businessDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return fail();
  const time = Date.parse(value + "T00:00:00.000Z");
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return fail();
  return value;
}
function amount(value: unknown): bigint {
  if (typeof value !== "bigint" || value <= 0n || value > 9223372036854775807n) return fail();
  return value;
}

/** Caller supplies complete owner-fenced claims, Store-resolved Business Dates and
 * immutable first-capture instants. Re-evaluate before first dispatch.
 * This only determines escalation, not permission, balance availability or Provider action.
 */
export function evaluateOrdinaryRefundEscalation(value: unknown) {
  try {
    const raw = exactPaymentObject(value, [
      ...scopeKeys,
      "requestReference",
      "observedAt",
      "businessDate",
      "selectedCaptures",
      "claims",
      "manualAllocationOverride",
    ]);
    const scope = Object.fromEntries(
      scopeKeys.map((key) => [key, parsePaymentReference(raw[key])]),
    );
    const requestReference = parsePaymentReference(raw.requestReference);
    const observedAt = parsePaymentInstant(raw.observedAt);
    const currentBusinessDate = businessDate(raw.businessDate);
    if (
      typeof raw.manualAllocationOverride !== "boolean" ||
      !Array.isArray(raw.selectedCaptures) ||
      raw.selectedCaptures.length < 1 ||
      raw.selectedCaptures.length > 1000 ||
      !Array.isArray(raw.claims) ||
      raw.claims.length < 1 ||
      raw.claims.length > 10000
    )
      return fail();
    const captures = new Set<string>();
    let differentBusinessDate = false,
      olderThan24Hours = false;
    for (const value of raw.selectedCaptures) {
      const capture = exactPaymentObject(value, [
        ...scopeKeys,
        "paymentReference",
        "firstCaptureReference",
        "firstCapturedAt",
        "businessDate",
      ]);
      for (const key of scopeKeys)
        if (parsePaymentReference(capture[key]) !== scope[key]) return fail();
      const payment = parsePaymentReference(capture.paymentReference);
      parsePaymentReference(capture.firstCaptureReference);
      if (captures.has(payment)) return fail();
      captures.add(payment);
      const firstCapturedAt = parsePaymentInstant(capture.firstCapturedAt);
      if (firstCapturedAt > observedAt) return fail();
      const captureBusinessDate = businessDate(capture.businessDate);
      differentBusinessDate ||= captureBusinessDate !== currentBusinessDate;
      olderThan24Hours ||=
        Date.parse(observedAt) - Date.parse(firstCapturedAt) > 24 * 60 * 60 * 1000;
    }
    const seen = new Set<string>();
    let cumulativeOrdinaryAmountMinor = 0n;
    let requested = false;
    for (const value of raw.claims) {
      const claim = exactPaymentObject(value, [
        ...scopeKeys,
        "requestReference",
        "kind",
        "status",
        "amountMinor",
        "currencyCode",
        "noProviderEffectReference",
      ]);
      for (const key of scopeKeys)
        if (parsePaymentReference(claim[key]) !== scope[key]) return fail();
      const reference = parsePaymentReference(claim.requestReference);
      if (seen.has(reference)) return fail();
      seen.add(reference);
      const claimedAmount = amount(claim.amountMinor);
      if (claim.currencyCode !== "CAD") return fail();
      if (claim.kind !== "Ordinary" && claim.kind !== "Compensation") return fail();
      const occupying = [
        "Requested",
        "Approved",
        "Processing",
        "Pending",
        "Unknown",
        "Confirmed",
      ].includes(String(claim.status));
      const terminal = claim.status === "Rejected" || claim.status === "Cancelled";
      if (!occupying && !terminal) return fail();
      let released = false;
      if (claim.noProviderEffectReference !== null) {
        if (!terminal) return fail();
        parsePaymentReference(claim.noProviderEffectReference);
        released = true;
      }
      if (reference === requestReference) {
        if (claim.kind !== "Ordinary" || terminal) return fail();
        requested = true;
      }
      if (claim.kind === "Ordinary" && !released) cumulativeOrdinaryAmountMinor += claimedAmount;
    }
    if (!requested) return fail();
    const reasons = [
      ...(differentBusinessDate ? ["DifferentBusinessDate" as const] : []),
      ...(olderThan24Hours ? ["MoreThan24Hours" as const] : []),
      ...(cumulativeOrdinaryAmountMinor > 10000n ? ["OrderOrdinaryTotalAboveCad100" as const] : []),
      ...(raw.manualAllocationOverride ? ["ManualAllocationOverride" as const] : []),
    ];
    return Object.freeze({
      policyVersion: ordinaryRefundPolicyVersion,
      requiresIndependentApproval: reasons.length > 0,
      reasons: Object.freeze(reasons),
      cumulativeOrdinaryAmountMinor,
    });
  } catch {
    return fail();
  }
}
