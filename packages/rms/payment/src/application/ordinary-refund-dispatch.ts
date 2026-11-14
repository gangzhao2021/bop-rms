import { createHash } from "node:crypto";
import {
  exactPaymentObject,
  parsePaymentInstant,
  parsePaymentDigest,
} from "./payment-intent-creation.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import {
  parseOrdinaryRefundOperation,
  encodeOrdinaryRefundOperation,
} from "./ordinary-refund-operation.js";
import { createOrdinaryRefundProviderRequest } from "./ordinary-refund-provider-request.js";
const refs = [
  "tenantReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "requestReference",
  "operationReference",
  "providerOperationReference",
  "paymentAttemptReference",
  "dispatchReference",
  "auditReference",
] as const;
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_DISPATCH_INVALID");
};

/** Append before Provider I/O. DispatchStarted means a send may have happened;
 * it is never proof of success or safe release. Actual gate/uniqueness/commit
 * checks belong to the writer before this record is usable for dispatch. */
export function parseOrdinaryRefundDispatch(value: unknown) {
  const raw = exactPaymentObject(value, [
    ...refs,
    "approvalReference",
    "claimVersion",
    "claimsDigest",
    "allocationDigest",
    "operationDigest",
    "providerRequestDigest",
    "startedAt",
    "status",
  ]);
  if (
    raw.status !== "DispatchStarted" ||
    typeof raw.claimVersion !== "number" ||
    !Number.isSafeInteger(raw.claimVersion) ||
    raw.claimVersion < 1
  )
    return fail();
  const identifiers = Object.fromEntries(
    refs.map((key) => [key, String(parsePaymentReference(raw[key]))]),
  ) as Record<(typeof refs)[number], string>;
  return Object.freeze({
    ...identifiers,
    approvalReference:
      raw.approvalReference === null ? null : String(parsePaymentReference(raw.approvalReference)),
    claimVersion: raw.claimVersion,
    claimsDigest: parsePaymentDigest(raw.claimsDigest),
    allocationDigest: parsePaymentDigest(raw.allocationDigest),
    operationDigest: parsePaymentDigest(raw.operationDigest),
    providerRequestDigest: parsePaymentDigest(raw.providerRequestDigest),
    startedAt: parsePaymentInstant(raw.startedAt),
    status: "DispatchStarted" as const,
  });
}
export function createOrdinaryRefundDispatch(value: unknown) {
  const raw = exactPaymentObject(value, [
    "operation",
    "providerBinding",
    "approvalReference",
    "claimVersion",
    "claimsDigest",
    "startedAt",
    "dispatchReference",
    "auditReference",
  ]);
  const operation = parseOrdinaryRefundOperation(raw.operation);
  const startedAt = parsePaymentInstant(raw.startedAt);
  const claimsDigest = parsePaymentDigest(raw.claimsDigest);
  if (
    startedAt < operation.preparedAt ||
    typeof raw.claimVersion !== "number" ||
    !Number.isSafeInteger(raw.claimVersion) ||
    raw.claimVersion < operation.claimVersion ||
    (raw.claimVersion === operation.claimVersion && claimsDigest !== operation.claimsDigest)
  )
    return fail();
  const request = createOrdinaryRefundProviderRequest(operation, raw.providerBinding);
  const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
  return parseOrdinaryRefundDispatch({
    tenantReference: operation.tenantReference,
    brandReference: operation.brandReference,
    storeReference: operation.storeReference,
    orderReference: operation.orderReference,
    requestReference: operation.requestReference,
    operationReference: operation.operationReference,
    providerOperationReference: operation.providerOperationReference,
    paymentAttemptReference: operation.paymentAttemptReference,
    dispatchReference: raw.dispatchReference,
    auditReference: raw.auditReference,
    approvalReference: raw.approvalReference,
    claimVersion: raw.claimVersion,
    claimsDigest,
    allocationDigest: operation.allocationDigest,
    operationDigest: hash(encodeOrdinaryRefundOperation(operation)),
    providerRequestDigest: hash(
      JSON.stringify(request, (_key, item: unknown) =>
        typeof item === "bigint" ? item.toString() : item,
      ),
    ),
    startedAt,
    status: "DispatchStarted",
  });
}
export function encodeOrdinaryRefundDispatch(value: unknown): string {
  return JSON.stringify(parseOrdinaryRefundDispatch(value));
}
export function decodeOrdinaryRefundDispatch(value: unknown) {
  if (typeof value !== "string" || value.length > 8192) return fail();
  try {
    return parseOrdinaryRefundDispatch(JSON.parse(value));
  } catch {
    return fail();
  }
}
