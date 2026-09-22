import {
  encodeStripeOrdinaryRefundRequest,
  encodeStripeOrdinaryRefundLookup,
} from "./stripe-ordinary-refund-request.js";
import {
  type CreateIntentRequest,
  type RetrieveIntentRequest,
  type RefundPaymentRequest,
} from "../../contracts/payment-provider-adapter.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  encodeStripeOnlineIntentRequest,
  type StripeOnlineIntentRequest,
} from "./stripe-online-intent-request.js";

export interface StripeOnlineTransportOptions {
  readonly brandReference: string;
  readonly storeReference: string;
  readonly environment: "Test" | "Live";
  readonly apiVersion: string;
  readonly secretKey: string;
  /** Explicit null means the key's own account; never infer a connected account. */
  readonly connectedAccount: string | null;
  readonly fetch?: typeof globalThis.fetch;
}
export class StripeOnlineTransportError extends Error {
  constructor(readonly code: "CONFIGURATION_INVALID" | "SCOPE_MISMATCH" | "RESPONSE_UNAVAILABLE") {
    super("payment provider transport unavailable");
    this.name = "StripeOnlineTransportError";
  }
}
const maximumResponseBytes = 1_048_576;

/** Internal raw response may contain client_secret. Normalize immediately; never persist/log it.
 * The owning Payment service must authorize and claim the operation before invoking transport.
 * No automatic retry: an ambiguous mutation remains the same operation for reconciliation. */
export function createStripeOnlineTransport(options: StripeOnlineTransportOptions) {
  const { brandReference, storeReference, environment, apiVersion, secretKey, connectedAccount } =
    options;
  try {
    parsePaymentReference(brandReference);
    parsePaymentReference(storeReference);
    if (
      !["Test", "Live"].includes(environment) ||
      !/^\d{4}-\d{2}-\d{2}(?:\.[a-z]+)?$/u.test(apiVersion) ||
      !new RegExp(
        "^(?:sk|rk)_" + (environment === "Test" ? "test" : "live") + "_[A-Za-z0-9]+$",
        "u",
      ).test(secretKey) ||
      (connectedAccount !== null && !/^acct_[A-Za-z0-9]+$/u.test(connectedAccount))
    )
      throw new Error();
  } catch {
    throw new StripeOnlineTransportError("CONFIGURATION_INVALID");
  }
  const send = options.fetch ?? globalThis.fetch;
  async function exchange(
    input: CreateIntentRequest | RetrieveIntentRequest | RefundPaymentRequest,
    encoded: StripeOnlineIntentRequest,
  ): Promise<{ status: number; payload: unknown }> {
    if (
      input.context.brandReference !== brandReference ||
      input.context.storeReference !== storeReference ||
      input.context.environment !== environment
    )
      throw new StripeOnlineTransportError("SCOPE_MISMATCH");
    const headers: Record<string, string> = {
      Authorization: "Bearer " + secretKey,
      "Stripe-Version": apiVersion,
      Accept: "application/json",
    };
    if (connectedAccount !== null) headers["Stripe-Account"] = connectedAccount;
    if (encoded.idempotencyKey !== null) headers["Idempotency-Key"] = encoded.idempotencyKey;
    if (encoded.body !== null) headers["Content-Type"] = "application/x-www-form-urlencoded";
    try {
      const response = await send("https://api.stripe.com" + encoded.path, {
        method: encoded.method,
        headers,
        ...(encoded.body === null ? {} : { body: encoded.body }),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return { status: response.status, payload: null };
      }
      if (
        !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") ||
        response.body === null
      )
        throw new Error();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maximumResponseBytes) throw new Error();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
      return {
        status: response.status,
        payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
      };
    } catch {
      throw new StripeOnlineTransportError("RESPONSE_UNAVAILABLE");
    }
  }
  return Object.freeze({
    async send(input: CreateIntentRequest | RetrieveIntentRequest) {
      return exchange(input, encodeStripeOnlineIntentRequest(input));
    },
    async refund(input: RefundPaymentRequest) {
      return exchange(input, encodeStripeOrdinaryRefundRequest(input));
    },
    async listRefunds(input: RefundPaymentRequest, startingAfter: string | null = null) {
      return exchange(input, encodeStripeOrdinaryRefundLookup(input, startingAfter));
    },
  });
}
