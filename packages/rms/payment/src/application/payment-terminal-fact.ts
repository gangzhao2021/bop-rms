import { createMoney, type Money } from "@rms/pricing";

import type { PaymentTerminalEnvelope } from "../contracts/payment-terminal-event.js";
import type { PaymentReference, ProviderReference } from "../contracts/payment-provider-adapter.js";
import { parsePaymentReference, parseProviderReference } from "./payment-provider-adapter.js";
import {
  parsePaymentDigest,
  parsePaymentInstant,
  type PaymentDigest,
  type PaymentInstant,
} from "./payment-intent-creation.js";
import {
  parseStripeEventReference,
  type StripeEventReference,
} from "./provider-webhook-verification.js";

export const paymentTerminalFailureReasons = [
  "Declined",
  "AuthenticationRequired",
  "Cancelled",
  "ProviderRejected",
] as const;
export type PaymentTerminalFailureReason = (typeof paymentTerminalFailureReasons)[number];
export const paymentTerminalRetryDispositions = [
  "Never",
  "SameOperation",
  "NewOperation",
  "Unknown",
] as const;
export type PaymentTerminalRetryDisposition = (typeof paymentTerminalRetryDispositions)[number];
export type PaymentTerminalSource = "VerifiedWebhook" | "ProviderRetrieval";

export const paymentTerminalErrorCodes = [
  "PAYMENT_TERMINAL_INPUT_INVALID",
  "PAYMENT_TERMINAL_SOURCE_NOT_FOUND",
  "PAYMENT_TERMINAL_SCOPE_MISMATCH",
  "PAYMENT_TERMINAL_STATE_NOT_TERMINAL",
  "PAYMENT_TERMINAL_AMOUNT_MISMATCH",
  "PAYMENT_TERMINAL_OUTCOME_CONFLICT",
  "PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE",
] as const;
export type PaymentTerminalErrorCode = (typeof paymentTerminalErrorCodes)[number];

export class PaymentTerminalError extends Error {
  readonly code: PaymentTerminalErrorCode;
  constructor(code: PaymentTerminalErrorCode) {
    super("payment terminal outcome is unavailable");
    this.name = "PaymentTerminalError";
    this.code = code;
  }
}

function invalid(code: PaymentTerminalErrorCode = "PAYMENT_TERMINAL_INPUT_INVALID"): never {
  throw new PaymentTerminalError(code);
}

function exact(value: unknown, fields: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return invalid();
    output[field] = descriptor.value;
  }
  return output;
}

function money(value: unknown): Money {
  try {
    const parsed = createMoney(value as Money);
    if (parsed.currencyCode !== "CAD" || parsed.amountMinor <= 0n) return invalid();
    return parsed;
  } catch {
    return invalid();
  }
}

export type PaymentTerminalObservation = Readonly<{
  observationReference: PaymentReference;
  webhookReceiptReference: PaymentReference;
  providerEventReference: StripeEventReference;
  providerAccountReference: PaymentReference;
  providerIntentReference: ProviderReference;
  environment: "Test" | "Live";
  paymentIntentReference: PaymentReference;
  paymentAttemptReference: PaymentReference;
  brandReference: PaymentReference;
  storeReference: PaymentReference;
  source: PaymentTerminalSource;
  status: "Captured" | "Failed";
  amount: Money | null;
  failureReason: PaymentTerminalFailureReason | null;
  retryDisposition: PaymentTerminalRetryDisposition | null;
  occurredAt: PaymentInstant;
  evidenceDigest: PaymentDigest;
}>;

export function parsePaymentTerminalObservation(value: unknown): PaymentTerminalObservation {
  const raw = exact(value, [
    "observationReference",
    "webhookReceiptReference",
    "providerEventReference",
    "providerAccountReference",
    "providerIntentReference",
    "environment",
    "paymentIntentReference",
    "paymentAttemptReference",
    "brandReference",
    "storeReference",
    "source",
    "status",
    "amount",
    "failureReason",
    "retryDisposition",
    "occurredAt",
    "evidenceDigest",
  ]);
  if (
    (raw.environment !== "Test" && raw.environment !== "Live") ||
    (raw.source !== "VerifiedWebhook" && raw.source !== "ProviderRetrieval")
  )
    return invalid();
  if (raw.status !== "Captured" && raw.status !== "Failed")
    return invalid("PAYMENT_TERMINAL_STATE_NOT_TERMINAL");
  const success = raw.status === "Captured";
  if (
    success
      ? raw.failureReason !== null || raw.retryDisposition !== null || raw.amount === null
      : raw.amount !== null ||
        !paymentTerminalFailureReasons.includes(raw.failureReason as never) ||
        !paymentTerminalRetryDispositions.includes(raw.retryDisposition as never)
  )
    return invalid();
  return Object.freeze({
    observationReference: parsePaymentReference(raw.observationReference),
    webhookReceiptReference: parsePaymentReference(raw.webhookReceiptReference),
    providerEventReference: parseStripeEventReference(raw.providerEventReference),
    providerAccountReference: parsePaymentReference(raw.providerAccountReference),
    providerIntentReference: parseProviderReference(raw.providerIntentReference),
    environment: raw.environment,
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
    brandReference: parsePaymentReference(raw.brandReference),
    storeReference: parsePaymentReference(raw.storeReference),
    source: raw.source,
    status: raw.status,
    amount: success ? money(raw.amount) : null,
    failureReason: success ? null : (raw.failureReason as PaymentTerminalFailureReason),
    retryDisposition: success ? null : (raw.retryDisposition as PaymentTerminalRetryDisposition),
    occurredAt: parsePaymentInstant(raw.occurredAt),
    evidenceDigest: parsePaymentDigest(raw.evidenceDigest),
  });
}

export type PaymentTerminalFact = Readonly<{
  paymentTransactionReference: PaymentReference;
  paymentIntentReference: PaymentReference;
  paymentAttemptReference: PaymentReference;
  orderReference: PaymentReference;
  brandReference: PaymentReference;
  storeReference: PaymentReference;
  webhookReceiptReference: PaymentReference;
  providerEventReference: StripeEventReference;
  providerAccountReference: PaymentReference;
  providerIntentReference: ProviderReference;
  environment: "Test" | "Live";
  observationReference: PaymentReference;
  source: PaymentTerminalSource;
  outcome: "Succeeded" | "Failed";
  amount: Money | null;
  failureReason: PaymentTerminalFailureReason | null;
  retryDisposition: PaymentTerminalRetryDisposition | null;
  occurredAt: PaymentInstant;
  recordedAt: PaymentInstant;
  evidenceDigest: PaymentDigest;
  event: PaymentTerminalEnvelope;
}>;

export interface PaymentTerminalIntentSource {
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly paymentOperationReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly provider: "Stripe";
  readonly environment: "Test" | "Live";
  readonly providerAccountReference: PaymentReference;
  readonly providerIntentReference: ProviderReference;
  readonly expectedAmount: Money;
}

export function parsePaymentTerminalIntentSource(value: unknown): PaymentTerminalIntentSource {
  const raw = exact(value, [
    "paymentIntentReference",
    "paymentAttemptReference",
    "paymentOperationReference",
    "orderReference",
    "brandReference",
    "storeReference",
    "provider",
    "environment",
    "providerAccountReference",
    "providerIntentReference",
    "expectedAmount",
  ]);
  if (raw.provider !== "Stripe" || (raw.environment !== "Test" && raw.environment !== "Live"))
    return invalid();
  return Object.freeze({
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
    paymentOperationReference: parsePaymentReference(raw.paymentOperationReference),
    orderReference: parsePaymentReference(raw.orderReference),
    brandReference: parsePaymentReference(raw.brandReference),
    storeReference: parsePaymentReference(raw.storeReference),
    provider: "Stripe",
    environment: raw.environment,
    providerAccountReference: parsePaymentReference(raw.providerAccountReference),
    providerIntentReference: parseProviderReference(raw.providerIntentReference),
    expectedAmount: money(raw.expectedAmount),
  });
}
