import {
  parseOrderPaymentPreparationEvidence,
  type OrderPaymentPreparationEvidence,
} from "@rms/ordering";

import { parsePaymentProviderOutcome, parsePaymentReference } from "./payment-provider-adapter.js";
import type {
  PaymentProviderOutcome,
  PaymentReference,
} from "../contracts/payment-provider-adapter.js";

export type PaymentInstant = string & { readonly __paymentInstant: unique symbol };
export type PaymentDigest = string & { readonly __paymentDigest: unique symbol };

export interface PaymentIntentAggregate {
  readonly paymentIntentReference: PaymentReference;
  readonly paymentOperationReference: PaymentReference;
  readonly intentDigest: PaymentDigest;
  readonly preparation: OrderPaymentPreparationEvidence;
  readonly paymentMethod: "OnlineCard";
  readonly captureMode: "Automatic";
  readonly aggregateVersion: 1;
  readonly creationStatus: "ProviderCreatePending";
  readonly createdAt: PaymentInstant;
}

export interface PaymentAttempt {
  readonly paymentAttemptReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly attemptNumber: 1;
  readonly provider: "Stripe";
  readonly providerEnvironment: "Test" | "Live";
  readonly providerIdempotencyDigest: PaymentDigest;
  readonly createdAt: PaymentInstant;
}

export interface PaymentIntentCreationRecord {
  readonly intent: PaymentIntentAggregate;
  readonly attempt: PaymentAttempt;
  readonly providerOutcome: PaymentProviderOutcome | null;
}

export type CreatePaymentIntentResult =
  | { readonly status: "Created"; readonly record: PaymentIntentCreationRecord }
  | { readonly status: "AlreadyCreated"; readonly record: PaymentIntentCreationRecord }
  | { readonly status: "Processing"; readonly record: PaymentIntentCreationRecord };

export const paymentIntentCreationErrorCodes = [
  "PAYMENT_INTENT_INPUT_INVALID",
  "PAYMENT_INTENT_PERMISSION_DENIED",
  "PAYMENT_INTENT_IDEMPOTENCY_CONFLICT",
  "PAYMENT_INTENT_ORDER_NOT_READY",
  "PAYMENT_INTENT_PREPARATION_EXPIRED",
  "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
  "PAYMENT_INTENT_PROVIDER_RESULT_INVALID",
] as const;
export type PaymentIntentCreationErrorCode = (typeof paymentIntentCreationErrorCodes)[number];

export class PaymentIntentCreationError extends Error {
  readonly code: PaymentIntentCreationErrorCode;

  constructor(code: PaymentIntentCreationErrorCode) {
    super("payment intent creation is unavailable");
    this.name = "PaymentIntentCreationError";
    this.code = code;
  }
}

function invalid(code: PaymentIntentCreationErrorCode = "PAYMENT_INTENT_INPUT_INVALID"): never {
  throw new PaymentIntentCreationError(code);
}

export function exactPaymentObject(
  value: unknown,
  fields: readonly string[],
  code: PaymentIntentCreationErrorCode = "PAYMENT_INTENT_INPUT_INVALID",
): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid(code);
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid(code);
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
        return invalid(code);
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof PaymentIntentCreationError) throw error;
    return invalid(code);
  }
}

export function parsePaymentInstant(value: unknown): PaymentInstant {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return invalid();
  return value as PaymentInstant;
}

export function parsePaymentDigest(value: unknown): PaymentDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) return invalid();
  return value as PaymentDigest;
}

function parseIntent(value: unknown): PaymentIntentAggregate {
  const raw = exactPaymentObject(value, [
    "paymentIntentReference",
    "paymentOperationReference",
    "intentDigest",
    "preparation",
    "paymentMethod",
    "captureMode",
    "aggregateVersion",
    "creationStatus",
    "createdAt",
  ]);
  if (
    raw.paymentMethod !== "OnlineCard" ||
    raw.captureMode !== "Automatic" ||
    raw.aggregateVersion !== 1 ||
    raw.creationStatus !== "ProviderCreatePending"
  )
    return invalid();
  return Object.freeze({
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    paymentOperationReference: parsePaymentReference(raw.paymentOperationReference),
    intentDigest: parsePaymentDigest(raw.intentDigest),
    preparation: parseOrderPaymentPreparationEvidence(raw.preparation),
    paymentMethod: "OnlineCard",
    captureMode: "Automatic",
    aggregateVersion: 1,
    creationStatus: "ProviderCreatePending",
    createdAt: parsePaymentInstant(raw.createdAt),
  });
}

function parseAttempt(value: unknown): PaymentAttempt {
  const raw = exactPaymentObject(value, [
    "paymentAttemptReference",
    "paymentIntentReference",
    "attemptNumber",
    "provider",
    "providerEnvironment",
    "providerIdempotencyDigest",
    "createdAt",
  ]);
  if (
    raw.attemptNumber !== 1 ||
    raw.provider !== "Stripe" ||
    (raw.providerEnvironment !== "Test" && raw.providerEnvironment !== "Live")
  )
    return invalid();
  return Object.freeze({
    paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    attemptNumber: 1,
    provider: "Stripe",
    providerEnvironment: raw.providerEnvironment,
    providerIdempotencyDigest: parsePaymentDigest(raw.providerIdempotencyDigest),
    createdAt: parsePaymentInstant(raw.createdAt),
  });
}

function verifyOutcome(
  value: unknown,
  intent: PaymentIntentAggregate,
  attempt: PaymentAttempt,
): PaymentProviderOutcome {
  let outcome: PaymentProviderOutcome;
  try {
    outcome = parsePaymentProviderOutcome(value);
  } catch {
    return invalid("PAYMENT_INTENT_PROVIDER_RESULT_INVALID");
  }
  const context = outcome.context;
  if (
    context.provider !== attempt.provider ||
    context.environment !== attempt.providerEnvironment ||
    String(context.brandReference) !== String(intent.preparation.brandReference) ||
    String(context.storeReference) !== String(intent.preparation.storeReference) ||
    context.paymentAttemptReference !== attempt.paymentAttemptReference ||
    context.operationReference !== intent.paymentOperationReference
  )
    return invalid("PAYMENT_INTENT_PROVIDER_RESULT_INVALID");
  if (
    outcome.kind === "Snapshot" &&
    (outcome.paymentMethod !== "OnlineCard" ||
      outcome.captureMode !== "Automatic" ||
      outcome.requestedAmount.currencyCode !== "CAD" ||
      outcome.requestedAmount.amountMinor !== intent.preparation.total.amountMinor)
  )
    return invalid("PAYMENT_INTENT_PROVIDER_RESULT_INVALID");
  return outcome;
}

export function parsePaymentIntentCreationRecord(value: unknown): PaymentIntentCreationRecord {
  const raw = exactPaymentObject(value, ["intent", "attempt", "providerOutcome"]);
  const intent = parseIntent(raw.intent);
  const attempt = parseAttempt(raw.attempt);
  if (
    attempt.paymentIntentReference !== intent.paymentIntentReference ||
    attempt.createdAt !== intent.createdAt
  )
    return invalid();
  return Object.freeze({
    intent,
    attempt,
    providerOutcome:
      raw.providerOutcome === null ? null : verifyOutcome(raw.providerOutcome, intent, attempt),
  });
}
