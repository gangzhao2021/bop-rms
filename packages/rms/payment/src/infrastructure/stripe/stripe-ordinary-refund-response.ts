import { parseOrdinaryRefundProviderResult } from "../../application/ordinary-refund-provider-result.js";
import { createHash } from "node:crypto";
import {
  createRefundPaymentRequest,
  parseProviderReference,
} from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import type { RefundPaymentRequest } from "../../contracts/payment-provider-adapter.js";
import { stripeOrdinaryRefundBinding } from "./stripe-ordinary-refund-request.js";
const fail = (): never => {
  throw new Error("STRIPE_ORDINARY_REFUND_RESPONSE_INVALID");
};
function field(value: unknown, key: string): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !("value" in descriptor)) return fail();
  return descriptor.value;
}
const statuses = ["pending", "requires_action", "succeeded", "failed", "canceled"] as const;

/** Normalize one authenticated, account-scoped Stripe Refund response.
 * Provider-reported status is evidence; persistence/reconciliation owns the
 * local refund lifecycle. Never retain the raw payload or destination details. */
export function normalizeStripeOrdinaryRefundResponse(
  input: RefundPaymentRequest,
  payload: unknown,
  at: string,
) {
  const request = createRefundPaymentRequest(input);
  const requestDigest = stripeOrdinaryRefundBinding(request);
  const observedAt = parsePaymentInstant(at);
  const reference = field(payload, "id");
  const amount = field(payload, "amount");
  const created = field(payload, "created");
  const status = statuses.find((candidate) => candidate === field(payload, "status"));
  if (
    field(payload, "object") !== "refund" ||
    typeof reference !== "string" ||
    !/^re_[A-Za-z0-9]+$/u.test(reference) ||
    field(payload, "payment_intent") !== request.providerIntentReference ||
    field(payload, "currency") !== "cad" ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount <= 0 ||
    BigInt(amount) !== request.amount.amountMinor ||
    typeof created !== "number" ||
    !Number.isSafeInteger(created) ||
    created < 0 ||
    created > Math.floor(Date.parse(observedAt) / 1000) ||
    field(field(payload, "metadata"), "bop_refund_binding") !== requestDigest ||
    status === undefined
  )
    return fail();
  const facts = Object.freeze({
    kind: "RefundObservation" as const,
    context: request.context,
    providerRefundReference: parseProviderReference(reference),
    providerIntentReference: request.providerIntentReference,
    amount: request.amount,
    status,
    createdAt: new Date(created * 1000).toISOString(),
    observedAt,
    providerRequestDigest: requestDigest,
  });
  const evidenceDigest =
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify(facts, (_key, item: unknown) =>
          typeof item === "bigint" ? item.toString() : item,
        ),
      )
      .digest("hex");
  return parseOrdinaryRefundProviderResult({ ...facts, evidenceDigest });
}
