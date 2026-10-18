import { parseOrdinaryRefundProviderOutcome } from "./ordinary-refund-provider-result.js";
import { createHash } from "node:crypto";
import {
  exactPaymentObject,
  parsePaymentInstant,
  parsePaymentDigest,
} from "./payment-intent-creation.js";
import { parsePaymentReference, createRefundPaymentRequest } from "./payment-provider-adapter.js";
import type { RefundPaymentRequest } from "../contracts/payment-provider-adapter.js";
import { parseOrdinaryRefundDispatch } from "./ordinary-refund-dispatch.js";

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
  "observationReference",
  "auditReference",
] as const;
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_OBSERVATION_INVALID");
};
const serialize = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );

/** Immutable channel observation. Even a fully refunded cumulative snapshot
 * is not confirmation of this individual operation or proof of safe release. */
export function parseOrdinaryRefundObservation(value: unknown) {
  const raw = exactPaymentObject(value, [
    ...refs,
    "providerRequestDigest",
    "recordedAt",
    "outcome",
    "state",
  ]);
  const identifiers = Object.fromEntries(
    refs.map((key) => [key, String(parsePaymentReference(raw[key]))]),
  ) as Record<(typeof refs)[number], string>;
  const outcome = parseOrdinaryRefundProviderOutcome(raw.outcome);
  const recordedAt = parsePaymentInstant(raw.recordedAt);
  if (
    raw.state !== "NeedsReconciliation" ||
    outcome.context.brandReference !== identifiers.brandReference ||
    outcome.context.storeReference !== identifiers.storeReference ||
    outcome.context.paymentAttemptReference !== identifiers.paymentAttemptReference ||
    outcome.context.operationReference !== identifiers.providerOperationReference ||
    (outcome.kind !== "Failure" && outcome.observedAt > recordedAt) ||
    (outcome.kind === "RefundObservation" &&
      outcome.providerRequestDigest !== raw.providerRequestDigest)
  )
    return fail();
  return Object.freeze({
    ...identifiers,
    providerRequestDigest: parsePaymentDigest(raw.providerRequestDigest),
    recordedAt,
    outcome,
    state: "NeedsReconciliation" as const,
  });
}
export function createOrdinaryRefundObservation(value: unknown) {
  const raw = exactPaymentObject(value, [
    "dispatch",
    "request",
    "outcome",
    "observationReference",
    "auditReference",
    "recordedAt",
  ]);
  const dispatch = parseOrdinaryRefundDispatch(raw.dispatch);
  const request = createRefundPaymentRequest(raw.request as RefundPaymentRequest);
  const outcome = parseOrdinaryRefundProviderOutcome(raw.outcome);
  const recordedAt = parsePaymentInstant(raw.recordedAt);
  const requestDigest = "sha256:" + createHash("sha256").update(serialize(request)).digest("hex");
  if (
    requestDigest !== dispatch.providerRequestDigest ||
    recordedAt < dispatch.startedAt ||
    request.context.brandReference !== dispatch.brandReference ||
    request.context.storeReference !== dispatch.storeReference ||
    request.context.paymentAttemptReference !== dispatch.paymentAttemptReference ||
    request.context.operationReference !== dispatch.providerOperationReference ||
    outcome.context.provider !== request.context.provider ||
    outcome.context.environment !== request.context.environment ||
    (outcome.kind === "RefundObservation" &&
      (outcome.providerRequestDigest !== requestDigest ||
        outcome.providerIntentReference !== request.providerIntentReference ||
        outcome.amount.amountMinor !== request.amount.amountMinor ||
        outcome.amount.currencyCode !== request.amount.currencyCode ||
        outcome.observedAt < dispatch.startedAt ||
        Date.parse(outcome.createdAt) <
          Math.floor(Date.parse(dispatch.startedAt) / 1000) * 1000)) ||
    (outcome.kind === "Snapshot" &&
      (outcome.providerIntentReference !== request.providerIntentReference ||
        outcome.paymentMethod !== request.originalPaymentMethod ||
        outcome.requestedAmount.currencyCode !== request.amount.currencyCode ||
        outcome.capturedAmount.amountMinor < request.amount.amountMinor ||
        outcome.observedAt < dispatch.startedAt))
  )
    return fail();
  return parseOrdinaryRefundObservation({
    tenantReference: dispatch.tenantReference,
    brandReference: dispatch.brandReference,
    storeReference: dispatch.storeReference,
    orderReference: dispatch.orderReference,
    requestReference: dispatch.requestReference,
    operationReference: dispatch.operationReference,
    providerOperationReference: dispatch.providerOperationReference,
    paymentAttemptReference: dispatch.paymentAttemptReference,
    dispatchReference: dispatch.dispatchReference,
    observationReference: raw.observationReference,
    auditReference: raw.auditReference,
    providerRequestDigest: requestDigest,
    recordedAt,
    outcome,
    state: "NeedsReconciliation",
  });
}
export function encodeOrdinaryRefundObservation(value: unknown): string {
  return serialize(parseOrdinaryRefundObservation(value));
}
export function decodeOrdinaryRefundObservation(value: unknown) {
  if (typeof value !== "string" || value.length > 32768) return fail();
  try {
    return parseOrdinaryRefundObservation(
      JSON.parse(value, (key, item: unknown) => {
        if (key !== "amountMinor") return item;
        if (typeof item !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(item)) return fail();
        return BigInt(item);
      }),
    );
  } catch {
    return fail();
  }
}
