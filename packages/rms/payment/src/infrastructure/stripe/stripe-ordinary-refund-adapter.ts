import type { RefundPaymentRequest } from "../../contracts/payment-provider-adapter.js";
import { createRefundPaymentRequest } from "../../application/payment-provider-adapter.js";
import {
  createStripeOnlineTransport,
  type StripeOnlineTransportOptions,
} from "./stripe-online-transport.js";
import { stripeOrdinaryRefundBinding } from "./stripe-ordinary-refund-request.js";
import { normalizeStripeOrdinaryRefundResponse } from "./stripe-ordinary-refund-response.js";
function field(value: unknown, key: string, optional = false): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("STRIPE_REFUND_PAGE_INVALID");
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property && optional) return undefined;
  if (!property || !("value" in property)) throw new Error("STRIPE_REFUND_PAGE_INVALID");
  return property.value;
}
/** Individual channel evidence only. Authenticated account selection belongs
 * to transport configuration; local dispatch and settlement remain separate.
 * Lookup is read-only and never turns absence or partial pages into no-effect. */
export function createStripeOrdinaryRefundAdapter(
  options: StripeOnlineTransportOptions & {
    now(): string;
    maxLookupPages?: number;
  },
) {
  const transport = createStripeOnlineTransport(options);
  const maxPages = options.maxLookupPages ?? 10;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 10)
    throw new Error("STRIPE_REFUND_LOOKUP_LIMIT_INVALID");
  const unresolved = (request: RefundPaymentRequest) =>
    Object.freeze({
      kind: "Unresolved" as const,
      context: request.context,
      reasonCode: "STRIPE_REFUND_UNRESOLVED" as const,
    });
  const parse = (input: RefundPaymentRequest) => {
    const request = createRefundPaymentRequest(input);
    stripeOrdinaryRefundBinding(request);
    return request;
  };
  return Object.freeze({
    async refundPayment(input: RefundPaymentRequest) {
      const request = parse(input);
      try {
        const response = await transport.refund(request);
        if (response.status < 200 || response.status >= 300) return unresolved(request);
        return normalizeStripeOrdinaryRefundResponse(request, response.payload, options.now());
      } catch {
        return unresolved(request);
      }
    },
    async lookupRefund(input: RefundPaymentRequest) {
      const request = parse(input);
      const expected = stripeOrdinaryRefundBinding(request);
      let cursor: string | null = null;
      let match: ReturnType<typeof normalizeStripeOrdinaryRefundResponse> | null = null;
      const seen = new Set<string>();
      try {
        for (let page = 0; page < maxPages; page++) {
          const response = await transport.listRefunds(request, cursor);
          if (response.status < 200 || response.status >= 300) return unresolved(request);
          const raw = response.payload;
          const data = field(raw, "data");
          const hasMore = field(raw, "has_more");
          if (
            field(raw, "object") !== "list" ||
            field(raw, "url") !== "/v1/refunds" ||
            !Array.isArray(data) ||
            data.length > 100 ||
            typeof hasMore !== "boolean" ||
            (hasMore && data.length === 0)
          )
            return unresolved(request);
          for (const entry of data) {
            const reference = field(entry, "id");
            if (
              field(entry, "object") !== "refund" ||
              field(entry, "payment_intent") !== request.providerIntentReference ||
              typeof reference !== "string" ||
              !/^re_[A-Za-z0-9]+$/u.test(reference) ||
              seen.has(reference)
            )
              return unresolved(request);
            seen.add(reference);
            cursor = reference;
            const metadata = field(entry, "metadata");
            const binding = metadata === null ? null : field(metadata, "bop_refund_binding", true);
            if (binding === expected) {
              if (match !== null) return unresolved(request);
              match = normalizeStripeOrdinaryRefundResponse(request, entry, options.now());
            }
          }
          if (!hasMore) return match ?? unresolved(request);
        }
      } catch {
        return unresolved(request);
      }
      return unresolved(request);
    },
  });
}
