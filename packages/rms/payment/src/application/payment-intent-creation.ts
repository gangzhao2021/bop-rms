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
  /** WP-2423 Q7: StoreCardMachine is a payment staff took on the Store's own card machine and
   * recorded; it never has a Provider intent (DEC-COUNTER-PAYMENT-RECORD). */
  readonly paymentMethod: "OnlineCard" | "StoreCardMachine";
  readonly captureMode: "Automatic";
  readonly aggregateVersion: 1;
  readonly creationStatus: "ProviderCreatePending" | "Recorded";
  readonly createdAt: PaymentInstant;
}

/**
 * WP-2423 Q20 (DEC-PAYMENT-CARD-RETRY): a customer may try another card after a decline. Every try
 * is a new append-only attempt on the same intent; this many tries in total, within the payment
 * window, then the customer pays staff at the counter.
 */
export const paymentAttemptLimit = 5;

export interface PaymentAttempt {
  readonly paymentAttemptReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  /** 1 is the first try; each later number is a retry after the previous attempt failed. */
  readonly attemptNumber: number;
  readonly provider: "Stripe" | "StoreCardMachine";
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
  "PAYMENT_INTENT_PROVIDER_DISABLED",
  "PAYMENT_INTENT_DEPENDENCY_UNAVAILABLE",
  "PAYMENT_INTENT_PROVIDER_RESULT_INVALID",
  /** WP-2423 Q20: the latest attempt has not failed (it is still open or being confirmed). */
  "PAYMENT_INTENT_RETRY_NOT_ALLOWED",
  /** WP-2423 Q20: this payment already has the maximum number of attempts. */
  "PAYMENT_INTENT_RETRY_LIMIT_REACHED",
  /** WP-2423 Q20: an attempt of this payment succeeded; nothing is left to pay. */
  "PAYMENT_INTENT_ALREADY_PAID",
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
  const cardMachine = raw.paymentMethod === "StoreCardMachine";
  if (
    (raw.paymentMethod !== "OnlineCard" && !cardMachine) ||
    raw.captureMode !== "Automatic" ||
    raw.aggregateVersion !== 1 ||
    raw.creationStatus !== (cardMachine ? "Recorded" : "ProviderCreatePending")
  )
    return invalid();
  return Object.freeze({
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    paymentOperationReference: parsePaymentReference(raw.paymentOperationReference),
    intentDigest: parsePaymentDigest(raw.intentDigest),
    preparation: parseOrderPaymentPreparationEvidence(raw.preparation),
    paymentMethod: cardMachine ? "StoreCardMachine" : "OnlineCard",
    captureMode: "Automatic",
    aggregateVersion: 1,
    creationStatus: cardMachine ? "Recorded" : "ProviderCreatePending",
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
    typeof raw.attemptNumber !== "number" ||
    !Number.isSafeInteger(raw.attemptNumber) ||
    raw.attemptNumber < 1 ||
    raw.attemptNumber > paymentAttemptLimit ||
    (raw.provider !== "Stripe" && raw.provider !== "StoreCardMachine") ||
    (raw.provider === "StoreCardMachine" && raw.attemptNumber !== 1) ||
    (raw.providerEnvironment !== "Test" && raw.providerEnvironment !== "Live")
  )
    return invalid();
  return Object.freeze({
    paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    attemptNumber: raw.attemptNumber,
    provider: raw.provider,
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
    // The first attempt starts with its intent; a retry starts later, inside the payment window.
    (attempt.attemptNumber === 1
      ? attempt.createdAt !== intent.createdAt
      : attempt.createdAt <= intent.createdAt ||
        String(attempt.createdAt) >= String(intent.preparation.capacityExpiresAt)) ||
    (intent.paymentMethod === "StoreCardMachine") !== (attempt.provider === "StoreCardMachine") ||
    (intent.paymentMethod === "StoreCardMachine" && raw.providerOutcome !== null)
  )
    return invalid();
  return Object.freeze({
    intent,
    attempt,
    providerOutcome:
      raw.providerOutcome === null ? null : verifyOutcome(raw.providerOutcome, intent, attempt),
  });
}
