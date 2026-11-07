import { createHash } from "node:crypto";
import { createMoney, parseCurrencyCode } from "@rms/pricing";
import {
  exactPaymentObject,
  parsePaymentInstant,
  parsePaymentDigest,
} from "./payment-intent-creation.js";
import {
  createPaymentProviderContext,
  parseProviderReference,
  parsePaymentProviderOutcome,
  createRefundPaymentRequest,
  createPaymentProviderFailure,
} from "./payment-provider-adapter.js";
import type {
  PaymentProviderContext,
  RefundPaymentRequest,
  SafeReasonCode,
} from "../contracts/payment-provider-adapter.js";
const fail = (): never => {
  throw new Error("ORDINARY_REFUND_PROVIDER_RESULT_INVALID");
};
const statuses = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;

/** Normalized individual channel evidence, independent of infrastructure.
 * This parser validates content, not authenticated Provider provenance. */
export function parseOrdinaryRefundProviderResult(value: unknown) {
  const raw = exactPaymentObject(value, [
    "kind",
    "context",
    "providerRefundReference",
    "providerIntentReference",
    "amount",
    "status",
    "createdAt",
    "observedAt",
    "providerRequestDigest",
    "evidenceDigest",
  ]);
  const amount = exactPaymentObject(raw.amount, ["amountMinor", "currencyCode"]);
  const status = statuses.find((candidate) => candidate === raw.status);
  const createdAt = parsePaymentInstant(raw.createdAt);
  const observedAt = parsePaymentInstant(raw.observedAt);
  if (
    raw.kind !== "RefundObservation" ||
    status === undefined ||
    amount.currencyCode !== "CAD" ||
    typeof amount.amountMinor !== "bigint" ||
    amount.amountMinor <= 0n ||
    amount.amountMinor > 99_999_999n ||
    createdAt > observedAt ||
    Date.parse(createdAt) % 1000 !== 0
  )
    return fail();
  const facts = Object.freeze({
    kind: "RefundObservation" as const,
    context: createPaymentProviderContext(raw.context as PaymentProviderContext),
    providerRefundReference: parseProviderReference(raw.providerRefundReference),
    providerIntentReference: parseProviderReference(raw.providerIntentReference),
    amount: createMoney({
      amountMinor: amount.amountMinor,
      currencyCode: parseCurrencyCode("CAD"),
    }),
    status,
    createdAt,
    observedAt,
    providerRequestDigest: parsePaymentDigest(raw.providerRequestDigest),
  });
  const evidenceDigest = parsePaymentDigest(raw.evidenceDigest);
  const expected =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify(facts, (_key, item: unknown) =>
          typeof item === "bigint" ? item.toString() : item,
        ),
      )
      .digest("hex");
  if (evidenceDigest !== expected) return fail();
  return Object.freeze({ ...facts, evidenceDigest });
}
export function parseOrdinaryRefundProviderOutcome(value: unknown) {
  const kind =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "kind")
      : undefined;
  return kind && "value" in kind && kind.value === "RefundObservation"
    ? parseOrdinaryRefundProviderResult(value)
    : parsePaymentProviderOutcome(value);
}

/** Preserve individual evidence, but sanitize invalid/foreign/unknown channel
 * responses. Failure never proves safe release of an already-started dispatch. */
export function bindOrdinaryRefundProviderOutcome(input: RefundPaymentRequest, value: unknown) {
  const request = createRefundPaymentRequest(input);
  const unknown = () =>
    createPaymentProviderFailure({
      kind: "Failure",
      context: request.context,
      code: "Unknown",
      retryDisposition: "Unknown",
      safeReasonCode: "PROVIDER_OUTCOME_UNKNOWN" as SafeReasonCode,
    });
  try {
    const outcome = parseOrdinaryRefundProviderOutcome(value);
    for (const key of [
      "provider",
      "environment",
      "brandReference",
      "storeReference",
      "paymentAttemptReference",
      "operationReference",
    ] as const)
      if (outcome.context[key] !== request.context[key]) return unknown();
    if (outcome.kind === "RefundObservation") {
      const digest =
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify(request, (_key, item: unknown) =>
              typeof item === "bigint" ? item.toString() : item,
            ),
          )
          .digest("hex");
      if (
        outcome.providerRequestDigest !== digest ||
        outcome.providerIntentReference !== request.providerIntentReference ||
        outcome.amount.amountMinor !== request.amount.amountMinor ||
        outcome.amount.currencyCode !== request.amount.currencyCode
      )
        return unknown();
    } else if (
      outcome.kind === "Snapshot" &&
      (outcome.providerIntentReference !== request.providerIntentReference ||
        outcome.paymentMethod !== request.originalPaymentMethod ||
        outcome.requestedAmount.currencyCode !== request.amount.currencyCode ||
        outcome.capturedAmount.amountMinor < request.amount.amountMinor)
    )
      return unknown();
    return outcome;
  } catch {
    return unknown();
  }
}
