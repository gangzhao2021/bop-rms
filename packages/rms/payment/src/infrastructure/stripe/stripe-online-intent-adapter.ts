import {
  createCreateIntentRequest,
  createRetrieveIntentRequest,
  createPaymentProviderFailure,
} from "../../application/payment-provider-adapter.js";
import type {
  CreateIntentRequest,
  RetrieveIntentRequest,
  PaymentProviderAdapter,
  PaymentProviderOutcome,
  PaymentProviderContext,
} from "../../contracts/payment-provider-adapter.js";
import {
  createStripeOnlineTransport,
  type StripeOnlineTransportOptions,
} from "./stripe-online-transport.js";
import { normalizeStripeOnlineIntentResponse } from "./stripe-online-intent-response.js";

export interface StripeOnlineIntentAdapterOptions extends StripeOnlineTransportOptions {
  readonly now: () => string;
}

/** Actual create/retrieve ports. Remaining lifecycle operations require their own adapters.
 * No raw response/client secret escapes this normalized public boundary. */
export function createStripeOnlineIntentAdapter(
  options: StripeOnlineIntentAdapterOptions,
): Pick<PaymentProviderAdapter, "createIntent" | "retrieveIntent"> {
  const transport = createStripeOnlineTransport(options);
  const now = options.now;
  const unknown = (context: PaymentProviderContext) =>
    createPaymentProviderFailure({
      kind: "Failure",
      context,
      code: "Unknown",
      retryDisposition: "Unknown",
      safeReasonCode: "STRIPE_RESULT_UNRESOLVED" as never,
    });
  async function invoke(
    request: CreateIntentRequest | RetrieveIntentRequest,
  ): Promise<PaymentProviderOutcome> {
    try {
      const response = await transport.send(request);
      // HTTP failure does not prove whether an attempted mutation reached Stripe.
      // Preserve ambiguity; the owner reconciles the original operation.
      if (response.status < 200 || response.status >= 300) return unknown(request.context);
      return normalizeStripeOnlineIntentResponse(request, response.payload, now());
    } catch {
      return unknown(request.context);
    }
  }
  return Object.freeze({
    createIntent(input) {
      return invoke(createCreateIntentRequest(input));
    },
    retrieveIntent(input) {
      return invoke(createRetrieveIntentRequest(input));
    },
  });
}
