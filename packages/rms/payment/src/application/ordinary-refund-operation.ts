import {
  exactPaymentObject,
  parsePaymentInstant,
  parsePaymentDigest,
} from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { ordinaryRefundPolicyVersion } from "./ordinary-refund-escalation.js";
const references = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "requestReference",
  "operationReference",
  "providerOperationReference",
  "paymentTransactionReference",
  "paymentIntentReference",
  "paymentAttemptReference",
  "firstCaptureReference",
  "providerAccountReference",
  "executorReference",
  "auditReference",
] as const;
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_OPERATION_INVALID");
};
/** Immutable first-dispatch preparation. Persist before Provider I/O; this
 * record alone does not prove dispatch, success, failure or release.
 */
export function parseOrdinaryRefundOperation(value: unknown) {
  const raw = exactPaymentObject(value, [
    ...references,
    "approvalReference",
    "claimVersion",
    "claimsDigest",
    "allocationDigest",
    "preparedAt",
    "environment",
    "currencyCode",
    "amountMinor",
    "policyVersion",
    "status",
  ]);
  const scope = Object.fromEntries(
    references.map((key) => [key, String(parsePaymentReference(raw[key]))]),
  ) as Record<(typeof references)[number], string>;
  if (
    raw.status !== "Prepared" ||
    raw.policyVersion !== ordinaryRefundPolicyVersion ||
    raw.currencyCode !== "CAD" ||
    !["Test", "Live"].includes(String(raw.environment)) ||
    typeof raw.amountMinor !== "bigint" ||
    raw.amountMinor <= 0n ||
    raw.amountMinor > 9223372036854775807n ||
    typeof raw.claimVersion !== "number" ||
    !Number.isSafeInteger(raw.claimVersion) ||
    raw.claimVersion < 1
  )
    return fail();
  return Object.freeze({
    ...scope,
    approvalReference:
      raw.approvalReference === null ? null : String(parsePaymentReference(raw.approvalReference)),
    claimVersion: raw.claimVersion,
    claimsDigest: parsePaymentDigest(raw.claimsDigest),
    allocationDigest: parsePaymentDigest(raw.allocationDigest),
    preparedAt: parsePaymentInstant(raw.preparedAt),
    environment: raw.environment as "Test" | "Live",
    currencyCode: "CAD" as const,
    amountMinor: raw.amountMinor,
    policyVersion: ordinaryRefundPolicyVersion,
    status: "Prepared" as const,
  });
}
export type OrdinaryRefundOperation = ReturnType<typeof parseOrdinaryRefundOperation>;
export function encodeOrdinaryRefundOperation(value: unknown): string {
  return JSON.stringify(parseOrdinaryRefundOperation(value), (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}
export function decodeOrdinaryRefundOperation(value: unknown): OrdinaryRefundOperation {
  if (typeof value !== "string" || value.length > 8192) return fail();
  try {
    return parseOrdinaryRefundOperation(
      JSON.parse(value, (key, item: unknown) => {
        if (key !== "amountMinor") return item;
        if (typeof item !== "string" || !/^[1-9][0-9]{0,18}$/u.test(item)) return fail();
        return BigInt(item);
      }),
    );
  } catch {
    return fail();
  }
}
