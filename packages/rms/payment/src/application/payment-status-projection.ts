import { createMoney, parseCurrencyCode, type Money } from "@rms/pricing";

import type { PaymentTerminalEnvelope } from "../contracts/payment-terminal-event.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { parsePaymentInstant, type PaymentInstant } from "./payment-intent-creation.js";
import { parsePaymentTerminalEnvelope } from "./payment-terminal-event.js";
import {
  parsePaymentFailedEnvelope,
  parsePaymentSucceededEnvelope,
} from "./payment-terminal-event.js";
import {
  paymentTerminalFailureReasons,
  paymentTerminalRetryDispositions,
  type PaymentTerminalFailureReason,
  type PaymentTerminalRetryDisposition,
} from "./payment-terminal-fact.js";
import type { PaymentReference } from "../contracts/payment-provider-adapter.js";

export type PaymentStatusFreshness = "Fresh" | "Stale" | "Rebuilding" | "Failed";

export interface PaymentStatusSnapshot {
  readonly paymentTransactionReference: PaymentReference;
  readonly paymentIntentReference: PaymentReference;
  readonly paymentAttemptReference: PaymentReference;
  readonly orderReference: PaymentReference;
  readonly brandReference: PaymentReference;
  readonly storeReference: PaymentReference;
  readonly terminalStatus: "Succeeded" | "Failed";
  readonly amount: Money | null;
  readonly failureReason: PaymentTerminalFailureReason | null;
  readonly retryDisposition: PaymentTerminalRetryDisposition | null;
  readonly terminalOccurredAt: PaymentInstant;
  readonly sourceEventReference: PaymentReference;
  readonly sourceAggregateVersion: 2;
}

export interface PaymentStatusProjection {
  readonly projectionName: "payment_status_v1";
  readonly projectionVersion: 1;
  readonly generationReference: PaymentReference;
  readonly sourceCheckpoint: PaymentReference;
  readonly projectedAt: PaymentInstant;
  readonly lastRebuiltAt: PaymentInstant | null;
  readonly freshnessStatus: PaymentStatusFreshness;
  readonly snapshot: PaymentStatusSnapshot;
}

export const paymentStatusProjectionErrorCodes = [
  "PAYMENT_STATUS_INPUT_INVALID",
  "PAYMENT_STATUS_VERSION_CONFLICT",
  "PAYMENT_STATUS_PERMISSION_DENIED",
  "PAYMENT_STATUS_NOT_FOUND",
  "PAYMENT_STATUS_DEPENDENCY_UNAVAILABLE",
] as const;
export type PaymentStatusProjectionErrorCode = (typeof paymentStatusProjectionErrorCodes)[number];

export class PaymentStatusProjectionError extends Error {
  readonly code: PaymentStatusProjectionErrorCode;
  constructor(code: PaymentStatusProjectionErrorCode) {
    super("payment status is unavailable");
    this.name = "PaymentStatusProjectionError";
    this.code = code;
  }
}

function invalid(code: PaymentStatusProjectionErrorCode = "PAYMENT_STATUS_INPUT_INVALID"): never {
  throw new PaymentStatusProjectionError(code);
}

function exact(value: unknown, fields: readonly string[]) {
  try {
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
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return invalid();
  }
}

function parseAmount(value: unknown): Money {
  try {
    const amount = createMoney(value as Money);
    if (amount.currencyCode !== "CAD" || amount.amountMinor <= 0n) return invalid();
    return amount;
  } catch {
    return invalid();
  }
}

function snapshot(value: unknown): PaymentStatusSnapshot {
  const raw = exact(value, [
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "brandReference",
    "storeReference",
    "terminalStatus",
    "amount",
    "failureReason",
    "retryDisposition",
    "terminalOccurredAt",
    "sourceEventReference",
    "sourceAggregateVersion",
  ]);
  if (
    raw.sourceAggregateVersion !== 2 ||
    (raw.terminalStatus !== "Succeeded" && raw.terminalStatus !== "Failed")
  )
    return invalid();
  const succeeded = raw.terminalStatus === "Succeeded";
  if (
    succeeded
      ? raw.amount === null || raw.failureReason !== null || raw.retryDisposition !== null
      : raw.amount !== null ||
        !paymentTerminalFailureReasons.includes(raw.failureReason as never) ||
        !paymentTerminalRetryDispositions.includes(raw.retryDisposition as never)
  )
    return invalid();
  return Object.freeze({
    paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
    orderReference: parsePaymentReference(raw.orderReference),
    brandReference: parsePaymentReference(raw.brandReference),
    storeReference: parsePaymentReference(raw.storeReference),
    terminalStatus: raw.terminalStatus,
    amount: succeeded ? parseAmount(raw.amount) : null,
    failureReason: succeeded ? null : (raw.failureReason as PaymentTerminalFailureReason),
    retryDisposition: succeeded ? null : (raw.retryDisposition as PaymentTerminalRetryDisposition),
    terminalOccurredAt: parsePaymentInstant(raw.terminalOccurredAt),
    sourceEventReference: parsePaymentReference(raw.sourceEventReference),
    sourceAggregateVersion: 2,
  });
}

export function parsePaymentStatusProjection(value: unknown): PaymentStatusProjection {
  try {
    const raw = exact(value, [
      "projectionName",
      "projectionVersion",
      "generationReference",
      "sourceCheckpoint",
      "projectedAt",
      "lastRebuiltAt",
      "freshnessStatus",
      "snapshot",
    ]);
    if (
      raw.projectionName !== "payment_status_v1" ||
      raw.projectionVersion !== 1 ||
      !["Fresh", "Stale", "Rebuilding", "Failed"].includes(String(raw.freshnessStatus))
    )
      return invalid();
    const parsed = snapshot(raw.snapshot);
    const checkpoint = parsePaymentReference(raw.sourceCheckpoint);
    if (checkpoint !== parsed.sourceEventReference) return invalid();
    return Object.freeze({
      projectionName: "payment_status_v1",
      projectionVersion: 1,
      generationReference: parsePaymentReference(raw.generationReference),
      sourceCheckpoint: checkpoint,
      projectedAt: parsePaymentInstant(raw.projectedAt),
      lastRebuiltAt: raw.lastRebuiltAt === null ? null : parsePaymentInstant(raw.lastRebuiltAt),
      freshnessStatus: raw.freshnessStatus as PaymentStatusFreshness,
      snapshot: parsed,
    });
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return invalid();
  }
}

export function buildPaymentStatusProjection(input: {
  readonly event: PaymentTerminalEnvelope;
  readonly generationReference: unknown;
  readonly projectedAt: unknown;
  readonly lastRebuiltAt?: unknown;
}): PaymentStatusProjection {
  try {
    const event = parsePaymentTerminalEnvelope(input.event);
    const succeeded = event.eventType === "PaymentSucceeded";
    const payload = succeeded
      ? parsePaymentSucceededEnvelope(event).payload
      : parsePaymentFailedEnvelope(event).payload;
    return parsePaymentStatusProjection({
      projectionName: "payment_status_v1",
      projectionVersion: 1,
      generationReference: parsePaymentReference(input.generationReference),
      sourceCheckpoint: event.eventId,
      projectedAt: parsePaymentInstant(input.projectedAt),
      lastRebuiltAt:
        input.lastRebuiltAt === undefined ? null : parsePaymentInstant(input.lastRebuiltAt),
      freshnessStatus: "Fresh",
      snapshot: {
        paymentTransactionReference: payload.paymentTransactionReference,
        paymentIntentReference: payload.paymentIntentReference,
        paymentAttemptReference: payload.paymentAttemptReference,
        orderReference: payload.orderReference,
        brandReference: event.tenantId,
        storeReference: event.storeId,
        terminalStatus: succeeded ? "Succeeded" : "Failed",
        amount: succeeded
          ? createMoney({
              amountMinor: BigInt(parsePaymentSucceededEnvelope(event).payload.amountMinor),
              currencyCode: parseCurrencyCode("CAD"),
            })
          : null,
        failureReason: succeeded ? null : parsePaymentFailedEnvelope(event).payload.reason,
        retryDisposition: succeeded
          ? null
          : parsePaymentFailedEnvelope(event).payload.retryDisposition,
        terminalOccurredAt: payload.terminalOccurredAt,
        sourceEventReference: event.eventId,
        sourceAggregateVersion: 2,
      },
    });
  } catch (error) {
    if (error instanceof PaymentStatusProjectionError) throw error;
    return invalid();
  }
}

export function equivalentPaymentStatus(
  left: PaymentStatusProjection,
  right: PaymentStatusProjection,
): boolean {
  return (
    left.sourceCheckpoint === right.sourceCheckpoint &&
    JSON.stringify(left.snapshot, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ) ===
      JSON.stringify(right.snapshot, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      )
  );
}
