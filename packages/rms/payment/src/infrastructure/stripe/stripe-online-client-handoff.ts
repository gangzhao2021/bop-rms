import { createMoney, type Money } from "@rms/pricing";
import { createRetrieveIntentRequest } from "../../application/payment-provider-adapter.js";
import type {
  RetrieveIntentRequest,
  PaymentProviderSnapshot,
} from "../../contracts/payment-provider-adapter.js";
import {
  createStripeOnlineTransport,
  type StripeOnlineTransportOptions,
} from "./stripe-online-transport.js";
import { normalizeStripeOnlineIntentResponse } from "./stripe-online-intent-response.js";

export class StripeOnlineClientHandoffError extends Error {
  constructor(readonly code: "NOT_READY" | "UNAVAILABLE") {
    super("customer payment handoff unavailable");
    this.name = "StripeOnlineClientHandoffError";
  }
}
export interface StripeOnlineClientHandoff {
  readonly snapshot: PaymentProviderSnapshot;
  /** Ephemeral credential: only the currently authorized customer, no URL/log/storage. */
  readonly clientSecret: string;
}
/** Server-only Provider port. Caller must reauthorize current Guest/Order/deadline both
 * before and after retrieval. expectedAmount must come from the persisted Payment owner. */
export function createStripeOnlineClientHandoff(
  options: StripeOnlineTransportOptions & { readonly now: () => string },
) {
  const transport = createStripeOnlineTransport(options);
  const now = options.now;
  return Object.freeze({
    async retrieve(
      input: RetrieveIntentRequest,
      expectedAmount: Money,
    ): Promise<StripeOnlineClientHandoff> {
      const request = createRetrieveIntentRequest(input);
      const expected = createMoney(expectedAmount);
      if (expected.currencyCode !== "CAD" || expected.amountMinor <= 0n)
        throw new StripeOnlineClientHandoffError("NOT_READY");
      try {
        const response = await transport.send(request);
        if (response.status !== 200) throw new StripeOnlineClientHandoffError("UNAVAILABLE");
        const snapshot = normalizeStripeOnlineIntentResponse(request, response.payload, now());
        if (
          snapshot.status !== "RequiresCustomerAction" ||
          snapshot.requestedAmount.amountMinor !== expected.amountMinor ||
          snapshot.requestedAmount.currencyCode !== expected.currencyCode
        )
          throw new StripeOnlineClientHandoffError("NOT_READY");
        const raw = response.payload as Record<string, unknown>;
        const secret = raw.client_secret;
        const prefix = snapshot.providerIntentReference + "_secret_";
        if (
          typeof secret !== "string" ||
          secret.length > 512 ||
          !secret.startsWith(prefix) ||
          !/^[A-Za-z0-9]+$/u.test(secret.slice(prefix.length))
        )
          throw new StripeOnlineClientHandoffError("UNAVAILABLE");
        return Object.freeze({ snapshot, clientSecret: secret });
      } catch (error) {
        if (error instanceof StripeOnlineClientHandoffError) throw error;
        throw new StripeOnlineClientHandoffError("UNAVAILABLE");
      }
    },
  });
}
