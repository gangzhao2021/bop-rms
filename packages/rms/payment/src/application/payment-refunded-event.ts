import { validateDomainEventEnvelope } from "@bop/eventing";

import type {
  PaymentRefundedEnvelope,
  PaymentRefundedPayload,
} from "../contracts/payment-refunded-event.js";
import {
  PaymentCompensationError,
  type PaymentProviderConfirmedRefundFact,
} from "./paid-without-fulfillable-order.js";
import { parsePaymentReference } from "./payment-provider-adapter.js";
import { parsePaymentInstant } from "./payment-intent-creation.js";

function invalid(): never {
  throw new PaymentCompensationError("PAYMENT_COMPENSATION_INPUT_INVALID");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    )
      return invalid();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof PaymentCompensationError) throw error;
    return invalid();
  }
}

function payload(value: unknown): PaymentRefundedPayload {
  const raw = exact(value, [
    "refundReference",
    "compensationCaseReference",
    "paymentTransactionReference",
    "paymentIntentReference",
    "paymentAttemptReference",
    "orderReference",
    "amountMinor",
    "currencyCode",
    "refundKind",
    "providerConfirmedAt",
  ]);
  if (
    typeof raw.amountMinor !== "string" ||
    !/^[1-9][0-9]*$/u.test(raw.amountMinor) ||
    raw.currencyCode !== "CAD" ||
    raw.refundKind !== "PaidWithoutFulfillableOrderCompensation"
  )
    return invalid();
  try {
    return Object.freeze({
      refundReference: parsePaymentReference(raw.refundReference),
      compensationCaseReference: parsePaymentReference(raw.compensationCaseReference),
      paymentTransactionReference: parsePaymentReference(raw.paymentTransactionReference),
      paymentIntentReference: parsePaymentReference(raw.paymentIntentReference),
      paymentAttemptReference: parsePaymentReference(raw.paymentAttemptReference),
      orderReference: parsePaymentReference(raw.orderReference),
      amountMinor: raw.amountMinor,
      currencyCode: "CAD",
      refundKind: "PaidWithoutFulfillableOrderCompensation",
      providerConfirmedAt: parsePaymentInstant(raw.providerConfirmedAt),
    });
  } catch {
    return invalid();
  }
}

export function parsePaymentRefundedEnvelope(value: unknown): PaymentRefundedEnvelope {
  try {
    const raw = exact(value, [
      "eventId",
      "eventType",
      "schemaVersion",
      "occurredAt",
      "producerModule",
      "tenantId",
      "storeId",
      "aggregateType",
      "aggregateId",
      "aggregateVersion",
      "correlationId",
      "causationId",
      "actor",
      "redactionClassification",
      "replayMetadata",
      "payload",
    ]);
    const actor = exact(raw.actor, ["type"]);
    const replayMetadata = exact(raw.replayMetadata, ["replaySafe"]);
    if (actor.type !== "System" || replayMetadata.replaySafe !== true) return invalid();
    const safeActor = Object.freeze({ type: "System" as const });
    const safeReplayMetadata = Object.freeze({ replaySafe: true as const });
    const parsed = payload(raw.payload);
    const envelope = validateDomainEventEnvelope({
      eventId: raw.eventId,
      eventType: raw.eventType,
      schemaVersion: raw.schemaVersion,
      occurredAt: raw.occurredAt,
      producerModule: raw.producerModule,
      tenantId: raw.tenantId,
      storeId: raw.storeId,
      aggregateType: raw.aggregateType,
      aggregateId: raw.aggregateId,
      aggregateVersion: raw.aggregateVersion,
      correlationId: raw.correlationId,
      causationId: raw.causationId,
      actor: safeActor,
      redactionClassification: raw.redactionClassification,
      replayMetadata: safeReplayMetadata,
      payload: parsed,
    } as PaymentRefundedEnvelope);
    if (
      envelope.eventType !== "PaymentRefunded" ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/payment" ||
      envelope.storeId === undefined ||
      envelope.aggregateType !== "PaymentTransaction" ||
      envelope.aggregateId !== parsed.paymentTransactionReference ||
      envelope.aggregateVersion !== 1n ||
      envelope.correlationId !== parsed.compensationCaseReference ||
      envelope.redactionClassification !== "payment" ||
      envelope.replayMetadata.replaySafe !== true ||
      envelope.occurredAt !== parsed.providerConfirmedAt
    )
      return invalid();
    return Object.freeze({
      ...envelope,
      actor: safeActor,
      replayMetadata: safeReplayMetadata,
      payload: parsed,
    });
  } catch (error) {
    if (error instanceof PaymentCompensationError) throw error;
    return invalid();
  }
}

export function createPaymentRefundedEnvelope(input: {
  readonly fact: PaymentProviderConfirmedRefundFact;
}): PaymentRefundedEnvelope {
  const fact = input.fact;
  return parsePaymentRefundedEnvelope({
    eventId: fact.eventReference,
    eventType: "PaymentRefunded",
    schemaVersion: 1,
    occurredAt: fact.providerConfirmedAt,
    producerModule: "@rms/payment",
    tenantId: fact.brandReference,
    storeId: fact.storeReference,
    aggregateType: "PaymentTransaction",
    aggregateId: fact.paymentTransactionReference,
    aggregateVersion: 1n,
    correlationId: fact.compensationCaseReference,
    causationId: fact.causationReference,
    actor: { type: "System" },
    redactionClassification: "payment",
    replayMetadata: { replaySafe: true },
    payload: {
      refundReference: fact.refundReference,
      compensationCaseReference: fact.compensationCaseReference,
      paymentTransactionReference: fact.paymentTransactionReference,
      paymentIntentReference: fact.paymentIntentReference,
      paymentAttemptReference: fact.paymentAttemptReference,
      orderReference: fact.orderReference,
      amountMinor: fact.amount.amountMinor.toString(),
      currencyCode: "CAD",
      refundKind: "PaidWithoutFulfillableOrderCompensation",
      providerConfirmedAt: fact.providerConfirmedAt,
    },
  });
}
