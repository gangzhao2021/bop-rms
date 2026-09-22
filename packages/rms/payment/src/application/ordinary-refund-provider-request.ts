import { createMoney, parseCurrencyCode } from "@rms/pricing";
import { parseOrdinaryRefundOperation } from "./ordinary-refund-operation.js";
import { exactPaymentObject } from "./payment-intent-creation.js";
import {
  createRefundPaymentRequest,
  parsePaymentReference,
  parseProviderReference,
  parseProviderIdempotencyKey,
} from "./payment-provider-adapter.js";

/** Deterministic request mapping only. The caller must load the persisted
 * operation and original Provider binding, persist first-dispatch evidence and
 * authorize dispatch before invoking the adapter. No new identity on retry. */
export function createOrdinaryRefundProviderRequest(operationValue: unknown, sourceValue: unknown) {
  const operation = parseOrdinaryRefundOperation(operationValue);
  const keys = [
    "tenantReference",
    "brandReference",
    "storeReference",
    "orderReference",
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "firstCaptureReference",
    "providerAccountReference",
  ] as const;
  const source = exactPaymentObject(sourceValue, [
    ...keys,
    "environment",
    "providerIntentReference",
    "originalPaymentMethod",
  ]);
  for (const key of keys)
    if (String(parsePaymentReference(source[key])) !== operation[key])
      throw new Error("ORDINARY_REFUND_PROVIDER_BINDING_MISMATCH");
  if (source.environment !== operation.environment || source.originalPaymentMethod !== "OnlineCard")
    throw new Error("ORDINARY_REFUND_PROVIDER_BINDING_MISMATCH");
  return createRefundPaymentRequest({
    operation: "RefundPayment",
    purpose: "RefundPayment",
    context: {
      provider: "Stripe",
      environment: operation.environment,
      brandReference: parsePaymentReference(operation.brandReference),
      storeReference: parsePaymentReference(operation.storeReference),
      paymentAttemptReference: parsePaymentReference(operation.paymentAttemptReference),
      operationReference: parsePaymentReference(operation.providerOperationReference),
    },
    idempotencyKey: parseProviderIdempotencyKey(
      "ordinary-refund:" + operation.providerOperationReference,
    ),
    providerIntentReference: parseProviderReference(source.providerIntentReference),
    originalPaymentMethod: "OnlineCard",
    amount: createMoney({
      currencyCode: parseCurrencyCode("CAD"),
      amountMinor: operation.amountMinor,
    }),
  });
}
