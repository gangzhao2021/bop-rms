import {
  createCancelIntentRequest,
  createCreateIntentRequest,
  createRetrieveIntentRequest,
} from "../../application/payment-provider-adapter.js";
import {
  PaymentProviderContractError,
  type CancelIntentRequest,
  type CreateIntentRequest,
  type RetrieveIntentRequest,
} from "../../contracts/payment-provider-adapter.js";

/** Internal transport description. Contains Provider IDs: never log or expose to clients. */
export interface StripeOnlineIntentRequest {
  readonly method: "POST" | "GET";
  readonly path: string;
  readonly body: string | null;
  readonly idempotencyKey: string | null;
}

/** Credentials, API version and account binding belong to the configured transport.
 * Do not confirm here: card collection/authentication uses the Provider client SDK. */
export function encodeStripeOnlineIntentRequest(
  input: CreateIntentRequest | RetrieveIntentRequest | CancelIntentRequest,
): StripeOnlineIntentRequest {
  // WP-2423 abandoned payment: cancel an intent the customer never confirmed (Stripe refuses one
  // that succeeded or is processing). Idempotent per attempt; answers the intent like a retrieval.
  if (input.operation === "CancelIntent") {
    const request = createCancelIntentRequest(input);
    if (!/^pi_[A-Za-z0-9]+$/u.test(request.providerIntentReference))
      throw new PaymentProviderContractError("PAYMENT_PROVIDER_INPUT_INVALID");
    return Object.freeze({
      method: "POST",
      path:
        "/v1/payment_intents/" + encodeURIComponent(request.providerIntentReference) + "/cancel",
      body: new URLSearchParams({
        cancellation_reason: "abandoned",
        "expand[]": "latest_charge",
      }).toString(),
      idempotencyKey: request.idempotencyKey,
    });
  }
  if (input.operation === "RetrieveIntent") {
    const request = createRetrieveIntentRequest(input);
    if (!/^pi_[A-Za-z0-9]+$/u.test(request.providerIntentReference))
      throw new PaymentProviderContractError("PAYMENT_PROVIDER_INPUT_INVALID");
    return Object.freeze({
      method: "GET",
      path:
        "/v1/payment_intents/" +
        encodeURIComponent(request.providerIntentReference) +
        "?expand%5B%5D=latest_charge",
      body: null,
      idempotencyKey: null,
    });
  }
  const request = createCreateIntentRequest(input);
  if (request.paymentMethod !== "OnlineCard" || request.captureMode !== "Automatic")
    throw new PaymentProviderContractError("PAYMENT_PROVIDER_POLICY_VIOLATION");
  if (request.amount.currencyCode !== "CAD" || request.amount.amountMinor > 99_999_999n)
    throw new PaymentProviderContractError("PAYMENT_PROVIDER_INPUT_INVALID");
  const body = new URLSearchParams({
    amount: request.amount.amountMinor.toString(),
    currency: "cad",
    capture_method: "automatic",
    confirmation_method: "automatic",
    "payment_method_types[]": "card",
    confirm: "false",
    "expand[]": "latest_charge",
  });
  return Object.freeze({
    method: "POST",
    path: "/v1/payment_intents",
    body: body.toString(),
    idempotencyKey: request.idempotencyKey,
  });
}
