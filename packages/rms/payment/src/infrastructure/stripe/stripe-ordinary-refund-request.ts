import { createHash } from "node:crypto";
import { createRefundPaymentRequest } from "../../application/payment-provider-adapter.js";
import type { RefundPaymentRequest } from "../../contracts/payment-provider-adapter.js";
import type { StripeOnlineIntentRequest } from "./stripe-online-intent-request.js";

const fail = (): never => {
  throw new Error("STRIPE_ORDINARY_REFUND_REQUEST_INVALID");
};
function parse(input: RefundPaymentRequest) {
  const request = createRefundPaymentRequest(input);
  if (
    request.originalPaymentMethod !== "OnlineCard" ||
    request.amount.currencyCode !== "CAD" ||
    request.amount.amountMinor > 99_999_999n ||
    !/^pi_[A-Za-z0-9]+$/u.test(request.providerIntentReference) ||
    request.idempotencyKey !== "ordinary-refund:" + request.context.operationReference
  )
    return fail();
  return request;
}
/** Scoped opaque request digest. Do not send local Order/Actor identifiers or
 * customer facts in Provider metadata. Same canonical bytes as dispatch. */
export function stripeOrdinaryRefundBinding(input: RefundPaymentRequest): string {
  const request = parse(input);
  return (
    "sha256:" +
    createHash("sha256")
      .update(
        JSON.stringify(request, (_key, item: unknown) =>
          typeof item === "bigint" ? item.toString() : item,
        ),
      )
      .digest("hex")
  );
}
export function encodeStripeOrdinaryRefundRequest(
  input: RefundPaymentRequest,
): StripeOnlineIntentRequest {
  const request = parse(input);
  return Object.freeze({
    method: "POST",
    path: "/v1/refunds",
    body: new URLSearchParams({
      payment_intent: request.providerIntentReference,
      amount: request.amount.amountMinor.toString(),
      "metadata[bop_refund_binding]": stripeOrdinaryRefundBinding(request),
    }).toString(),
    idempotencyKey: request.idempotencyKey,
  });
}
/** Read-only recovery pages. An empty or incomplete list is not proof that
 * an ambiguous original send had no effect. Never create a new refund here. */
export function encodeStripeOrdinaryRefundLookup(
  input: RefundPaymentRequest,
  startingAfter: string | null = null,
): StripeOnlineIntentRequest {
  const request = parse(input);
  if (startingAfter !== null && !/^re_[A-Za-z0-9]+$/u.test(startingAfter)) return fail();
  const query = new URLSearchParams({
    payment_intent: request.providerIntentReference,
    limit: "100",
  });
  if (startingAfter !== null) query.set("starting_after", startingAfter);
  return Object.freeze({
    method: "GET",
    path: "/v1/refunds?" + query.toString(),
    body: null,
    idempotencyKey: null,
  });
}
