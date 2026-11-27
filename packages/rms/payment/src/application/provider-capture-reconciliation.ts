import { createMoney, parseCurrencyCode } from "@rms/pricing";
import { parsePaymentReference, parseProviderReference } from "./payment-provider-adapter.js";
import {
  exactPaymentObject,
  parsePaymentDigest,
  parsePaymentInstant,
} from "./payment-intent-creation.js";
import { PaymentReconciliationError } from "./payment-reconciliation.js";
const fields = [
  "brandReference",
  "storeReference",
  "providerAccountReference",
  "environment",
  "providerIntentReference",
  "providerTransactionReference",
  "paymentOperationReference",
  "paymentAttemptReference",
  "amount",
  "occurredAt",
  "observedAt",
  "evidenceDigest",
] as const;
const fail = (): never => {
  throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_INPUT_INVALID");
};
export function parseProviderCaptureReconciliationEvidence(value: unknown) {
  try {
    const raw = exactPaymentObject(value, fields),
      money = exactPaymentObject(raw.amount, ["amountMinor", "currencyCode"]);
    if (
      (raw.environment !== "Test" && raw.environment !== "Live") ||
      money.currencyCode !== "CAD" ||
      typeof money.amountMinor !== "bigint" ||
      money.amountMinor <= 0n
    )
      return fail();
    const occurredAt = parsePaymentInstant(raw.occurredAt),
      observedAt = parsePaymentInstant(raw.observedAt);
    if (occurredAt > observedAt) return fail();
    return Object.freeze({
      brandReference: parsePaymentReference(raw.brandReference),
      storeReference: parsePaymentReference(raw.storeReference),
      providerAccountReference: parsePaymentReference(raw.providerAccountReference),
      environment: raw.environment as "Test" | "Live",
      providerIntentReference: parseProviderReference(raw.providerIntentReference),
      providerTransactionReference: parseProviderReference(raw.providerTransactionReference),
      paymentOperationReference: parsePaymentReference(raw.paymentOperationReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      amount: createMoney({
        amountMinor: money.amountMinor,
        currencyCode: parseCurrencyCode("CAD"),
      }),
      occurredAt,
      observedAt,
      evidenceDigest: parsePaymentDigest(raw.evidenceDigest),
    });
  } catch {
    return fail();
  }
}
export type ProviderCaptureReconciliationEvidence = ReturnType<
  typeof parseProviderCaptureReconciliationEvidence
>;
/** A successful link is identity evidence only, never proof of a captured internal terminal. */
export function reviewProviderCaptureOperationBinding(
  evidenceValue: unknown,
  bindingValue: unknown,
) {
  const evidence = parseProviderCaptureReconciliationEvidence(evidenceValue);
  if (bindingValue === null)
    return Object.freeze({
      status: "MissingInternalOperation" as const,
      evidence,
      paymentIntentReference: null,
    });
  try {
    const binding = exactPaymentObject(bindingValue, [
      "brandReference",
      "storeReference",
      "providerAccountReference",
      "environment",
      "providerIntentReference",
      "paymentOperationReference",
      "paymentAttemptReference",
      "paymentIntentReference",
      "amount",
    ]);
    for (const field of [
      "brandReference",
      "storeReference",
      "providerAccountReference",
      "environment",
      "providerIntentReference",
      "paymentOperationReference",
      "paymentAttemptReference",
    ] as const)
      if (binding[field] !== evidence[field]) return fail();
    const money = exactPaymentObject(binding.amount, ["amountMinor", "currencyCode"]);
    if (
      money.amountMinor !== evidence.amount.amountMinor ||
      money.currencyCode !== evidence.amount.currencyCode
    )
      return fail();
    return Object.freeze({
      status: "Linked" as const,
      evidence,
      paymentIntentReference: parsePaymentReference(binding.paymentIntentReference),
    });
  } catch {
    return fail();
  }
}
