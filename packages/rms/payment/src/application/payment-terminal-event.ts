import { validateDomainEventEnvelope } from "@bop/eventing";

import type {
  PaymentFailedEnvelope,
  PaymentSucceededEnvelope,
  PaymentTerminalEnvelope,
} from "../contracts/payment-terminal-event.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { parsePaymentInstant } from "./payment-intent-creation.js";
import {
  paymentTerminalFailureReasons,
  paymentTerminalRetryDispositions,
  PaymentTerminalError,
  type PaymentTerminalFact,
} from "./payment-terminal-fact.js";

function invalid(): never {
  throw new PaymentTerminalError("PAYMENT_TERMINAL_INPUT_INVALID");
}

function payload(value: unknown, eventType: "PaymentSucceeded" | "PaymentFailed") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  const raw = value as Record<string, unknown>;
  const common = [
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "terminalOccurredAt",
  ];
  const fields =
    eventType === "PaymentSucceeded"
      ? [...common, "amountMinor", "currencyCode", "evidenceKind"]
      : [...common, "reason", "retryDisposition"];
  if (
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const result: Record<string, string> = {
    paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
    paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
    paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
    orderReference: parsePaymentReference(raw.orderReference),
    terminalOccurredAt: parsePaymentInstant(raw.terminalOccurredAt),
  };
  if (eventType === "PaymentSucceeded") {
    if (
      typeof raw.amountMinor !== "string" ||
      !/^[1-9][0-9]*$/u.test(raw.amountMinor) ||
      raw.currencyCode !== "CAD" ||
      raw.evidenceKind !== "Captured"
    )
      return invalid();
    return Object.freeze({
      ...result,
      amountMinor: raw.amountMinor,
      currencyCode: "CAD",
      evidenceKind: "Captured",
    });
  }
  if (
    !paymentTerminalFailureReasons.includes(raw.reason as never) ||
    !paymentTerminalRetryDispositions.includes(raw.retryDisposition as never)
  )
    return invalid();
  return Object.freeze({
    ...result,
    reason: raw.reason as string,
    retryDisposition: raw.retryDisposition as string,
  });
}

export function parsePaymentTerminalEnvelope(value: unknown): PaymentTerminalEnvelope {
  try {
    const envelope = validateDomainEventEnvelope(value as PaymentTerminalEnvelope);
    if (envelope.eventType !== "PaymentSucceeded" && envelope.eventType !== "PaymentFailed")
      return invalid();
    const parsed = payload(envelope.payload, envelope.eventType) as Readonly<
      Record<string, string>
    >;
    if (
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/payment" ||
      envelope.storeId === undefined ||
      envelope.aggregateType !== "PaymentIntent" ||
      envelope.aggregateId !== parsed.paymentIntentReference ||
      envelope.aggregateVersion !== 2n ||
      envelope.actor.type !== "System" ||
      envelope.redactionClassification !== "payment" ||
      envelope.replayMetadata.replaySafe !== true ||
      Object.keys(envelope.replayMetadata).length !== 1 ||
      envelope.occurredAt !== parsed.terminalOccurredAt
    )
      return invalid();
    return Object.freeze({ ...envelope, payload: parsed }) as PaymentTerminalEnvelope;
  } catch (error) {
    if (error instanceof PaymentTerminalError) throw error;
    return invalid();
  }
}

export function createPaymentTerminalEnvelope(input: {
  readonly eventReference: unknown;
  readonly correlationReference: unknown;
  readonly fact: Omit<PaymentTerminalFact, "event">;
}): PaymentTerminalEnvelope {
  const fact = input.fact;
  const common = {
    eventId: parsePaymentReference(input.eventReference),
    eventType: fact.outcome === "Succeeded" ? "PaymentSucceeded" : "PaymentFailed",
    schemaVersion: 1,
    occurredAt: fact.occurredAt,
    producerModule: "@rms/payment",
    tenantId: fact.brandReference,
    storeId: fact.storeReference,
    aggregateType: "PaymentIntent",
    aggregateId: fact.paymentIntentReference,
    aggregateVersion: 2n,
    correlationId: parsePaymentReference(input.correlationReference),
    causationId: fact.causationReference,
    actor: { type: "System" },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
  } as const;
  return parsePaymentTerminalEnvelope(
    fact.outcome === "Succeeded"
      ? {
          ...common,
          payload: {
            paymentTransactionReference: fact.paymentTransactionReference,
            paymentIntentReference: fact.paymentIntentReference,
            paymentAttemptReference: fact.paymentAttemptReference,
            orderReference: fact.orderReference,
            amountMinor: String(fact.amount?.amountMinor),
            currencyCode: "CAD",
            evidenceKind: "Captured",
            terminalOccurredAt: fact.occurredAt,
          },
        }
      : {
          ...common,
          payload: {
            paymentTransactionReference: fact.paymentTransactionReference,
            paymentIntentReference: fact.paymentIntentReference,
            paymentAttemptReference: fact.paymentAttemptReference,
            orderReference: fact.orderReference,
            reason: fact.failureReason,
            retryDisposition: fact.retryDisposition,
            terminalOccurredAt: fact.occurredAt,
          },
        },
  );
}

export function parsePaymentSucceededEnvelope(value: unknown): PaymentSucceededEnvelope {
  const event = parsePaymentTerminalEnvelope(value);
  if (event.eventType !== "PaymentSucceeded") return invalid();
  return event as PaymentSucceededEnvelope;
}

export function parsePaymentFailedEnvelope(value: unknown): PaymentFailedEnvelope {
  const event = parsePaymentTerminalEnvelope(value);
  if (event.eventType !== "PaymentFailed") return invalid();
  return event as PaymentFailedEnvelope;
}
