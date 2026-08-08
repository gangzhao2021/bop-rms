import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  paymentFailureReasons,
  paymentRetryDispositions,
  type OrderPaymentFailureRecord,
  type OrderPaymentOutcomeDisposition,
  type PaymentFailedEnvelope,
  type PaymentFailedPayload,
  type PaymentOutcomeEnvelope,
  type PaymentSucceededEnvelope,
  type PaymentSucceededPayload,
} from "../contracts/order-payment-outcome.js";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";

export const orderPaymentOutcomeErrorCodes = [
  "ORDER_PAYMENT_OUTCOME_INPUT_INVALID",
  "ORDER_PAYMENT_OUTCOME_PERMISSION_DENIED",
  "ORDER_PAYMENT_OUTCOME_CONFLICT",
  "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE",
  "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE",
] as const;
export type OrderPaymentOutcomeErrorCode = (typeof orderPaymentOutcomeErrorCodes)[number];

export class OrderPaymentOutcomeError extends Error {
  readonly code: OrderPaymentOutcomeErrorCode;

  constructor(code: OrderPaymentOutcomeErrorCode) {
    super(
      code === "ORDER_PAYMENT_OUTCOME_INPUT_INVALID"
        ? "order payment outcome input is invalid"
        : code === "ORDER_PAYMENT_OUTCOME_PERMISSION_DENIED"
          ? "order payment outcome is unavailable"
          : code === "ORDER_PAYMENT_OUTCOME_CONFLICT"
            ? "order payment outcome conflict"
            : "order payment outcome is unavailable",
    );
    this.name = "OrderPaymentOutcomeError";
    this.code = code;
  }
}

function invalid(): never {
  throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_INPUT_INVALID");
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
    if (error instanceof OrderPaymentOutcomeError) throw error;
    return invalid();
  }
}

function systemActor(value: unknown) {
  const raw = exact(value, ["type"]);
  if (raw.type !== "System") return invalid();
  return Object.freeze({ type: "System" as const });
}

function replayMetadata(value: unknown) {
  const raw = exact(value, ["replaySafe"]);
  if (raw.replaySafe !== true) return invalid();
  return Object.freeze({ replaySafe: true as const });
}

const paymentCommonPayloadFields = [
  "paymentTransactionReference",
  "paymentIntentReference",
  "paymentAttemptReference",
  "orderReference",
  "terminalOccurredAt",
] as const;

function paymentSucceededPayload(value: unknown): PaymentSucceededPayload {
  const raw = exact(value, [
    ...paymentCommonPayloadFields,
    "amountMinor",
    "currencyCode",
    "evidenceKind",
  ]);
  if (
    typeof raw.amountMinor !== "string" ||
    !/^[1-9][0-9]*$/u.test(raw.amountMinor) ||
    raw.currencyCode !== "CAD" ||
    raw.evidenceKind !== "Captured"
  )
    return invalid();
  return Object.freeze({
    paymentTransactionReference: parseOrderingReference(raw.paymentTransactionReference),
    paymentIntentReference: parseOrderingReference(raw.paymentIntentReference),
    paymentAttemptReference: parseOrderingReference(raw.paymentAttemptReference),
    orderReference: parseOrderingReference(raw.orderReference),
    amountMinor: raw.amountMinor,
    currencyCode: "CAD" as const,
    evidenceKind: "Captured" as const,
    terminalOccurredAt: parseOrderingInstant(raw.terminalOccurredAt),
  });
}

function paymentFailedPayload(value: unknown): PaymentFailedPayload {
  const raw = exact(value, [...paymentCommonPayloadFields, "reason", "retryDisposition"]);
  if (
    !paymentFailureReasons.includes(raw.reason as never) ||
    !paymentRetryDispositions.includes(raw.retryDisposition as never)
  )
    return invalid();
  return Object.freeze({
    paymentTransactionReference: parseOrderingReference(raw.paymentTransactionReference),
    paymentIntentReference: parseOrderingReference(raw.paymentIntentReference),
    paymentAttemptReference: parseOrderingReference(raw.paymentAttemptReference),
    orderReference: parseOrderingReference(raw.orderReference),
    reason: raw.reason as PaymentFailedPayload["reason"],
    retryDisposition: raw.retryDisposition as PaymentFailedPayload["retryDisposition"],
    terminalOccurredAt: parseOrderingInstant(raw.terminalOccurredAt),
  });
}

const envelopeFields = [
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
  "payload",
  "redactionClassification",
  "replayMetadata",
] as const;

export function parsePaymentOutcomeEnvelope(value: unknown): PaymentOutcomeEnvelope {
  try {
    const raw = exact(value, envelopeFields);
    if (raw.eventType !== "PaymentSucceeded" && raw.eventType !== "PaymentFailed") return invalid();
    const parsedPayload =
      raw.eventType === "PaymentSucceeded"
        ? paymentSucceededPayload(raw.payload)
        : paymentFailedPayload(raw.payload);
    const candidate = {
      eventId: parseOrderingReference(raw.eventId),
      eventType: raw.eventType,
      schemaVersion: raw.schemaVersion,
      occurredAt: parseOrderingInstant(raw.occurredAt),
      producerModule: raw.producerModule,
      tenantId: parseOrderingReference(raw.tenantId),
      storeId: parseOrderingReference(raw.storeId),
      aggregateType: raw.aggregateType,
      aggregateId: parseOrderingReference(raw.aggregateId),
      aggregateVersion: raw.aggregateVersion,
      correlationId: parseOrderingReference(raw.correlationId),
      causationId: parseOrderingReference(raw.causationId),
      actor: systemActor(raw.actor),
      payload: parsedPayload,
      redactionClassification: raw.redactionClassification,
      replayMetadata: replayMetadata(raw.replayMetadata),
    };
    const envelope = validateDomainEventEnvelope(candidate as PaymentOutcomeEnvelope);
    if (
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/payment" ||
      envelope.aggregateType !== "PaymentIntent" ||
      envelope.aggregateId !== parsedPayload.paymentIntentReference ||
      envelope.aggregateVersion !== 2n ||
      envelope.actor.type !== "System" ||
      envelope.redactionClassification !== "payment" ||
      envelope.occurredAt !== parsedPayload.terminalOccurredAt
    )
      return invalid();
    return Object.freeze(candidate) as PaymentOutcomeEnvelope;
  } catch (error) {
    if (error instanceof OrderPaymentOutcomeError) throw error;
    return invalid();
  }
}

export function parsePaymentSucceededEnvelope(value: unknown): PaymentSucceededEnvelope {
  const event = parsePaymentOutcomeEnvelope(value);
  if (event.eventType !== "PaymentSucceeded") return invalid();
  return event;
}

export function parsePaymentFailedEnvelope(value: unknown): PaymentFailedEnvelope {
  const event = parsePaymentOutcomeEnvelope(value);
  if (event.eventType !== "PaymentFailed") return invalid();
  return event;
}

const dispositionCommonFields = [
  "dispositionReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "paymentTransactionReference",
  "paymentIntentReference",
  "paymentAttemptReference",
  "paymentEventReference",
  "sourceVersion",
  "sourceCheckpoint",
  "sourceDigest",
  "evaluatedAt",
  "disposition",
] as const;

export function parseOrderPaymentOutcomeDisposition(
  value: unknown,
): OrderPaymentOutcomeDisposition {
  try {
    const discriminator = exact(value, Reflect.ownKeys(value as object).map(String));
    const fields =
      discriminator.disposition === "Confirmed"
        ? [
            ...dispositionCommonFields,
            "confirmationReference",
            "sourceSnapshotDigest",
            "confirmedAt",
          ]
        : discriminator.disposition === "AwaitingAcceptance"
          ? [...dispositionCommonFields, "reason"]
          : discriminator.disposition === "PaidWithoutFulfillableOrder"
            ? [...dispositionCommonFields, "reason", "kitchenReleaseDisposition"]
            : invalid();
    const raw = exact(value, fields);
    if (!Number.isSafeInteger(raw.sourceVersion) || (raw.sourceVersion as number) < 1)
      return invalid();
    const common = {
      dispositionReference: parseOrderingReference(raw.dispositionReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      paymentTransactionReference: parseOrderingReference(raw.paymentTransactionReference),
      paymentIntentReference: parseOrderingReference(raw.paymentIntentReference),
      paymentAttemptReference: parseOrderingReference(raw.paymentAttemptReference),
      paymentEventReference: parseOrderingReference(raw.paymentEventReference),
      sourceVersion: raw.sourceVersion as number,
      sourceCheckpoint: parseOrderingReference(raw.sourceCheckpoint),
      sourceDigest: parseOrderingHash(raw.sourceDigest),
      evaluatedAt: parseOrderingInstant(raw.evaluatedAt),
    };
    if (raw.disposition === "Confirmed")
      return Object.freeze({
        ...common,
        disposition: "Confirmed" as const,
        confirmationReference: parseOrderingReference(raw.confirmationReference),
        sourceSnapshotDigest: parseOrderingHash(raw.sourceSnapshotDigest),
        confirmedAt: parseOrderingInstant(raw.confirmedAt),
      });
    if (raw.disposition === "AwaitingAcceptance") {
      if (raw.reason !== "OrderAcceptancePending") return invalid();
      return Object.freeze({
        ...common,
        disposition: "AwaitingAcceptance" as const,
        reason: "OrderAcceptancePending" as const,
      });
    }
    if (
      raw.disposition !== "PaidWithoutFulfillableOrder" ||
      !["CapacityExpired", "SubmissionCancelled", "OrderNoLongerFulfillable"].includes(
        raw.reason as string,
      ) ||
      raw.kitchenReleaseDisposition !== "Blocked"
    )
      return invalid();
    return Object.freeze({
      ...common,
      disposition: "PaidWithoutFulfillableOrder" as const,
      reason: raw.reason as "CapacityExpired" | "SubmissionCancelled" | "OrderNoLongerFulfillable",
      kitchenReleaseDisposition: "Blocked" as const,
    });
  } catch (error) {
    if (error instanceof OrderPaymentOutcomeError) throw error;
    return invalid();
  }
}

export function parseOrderPaymentFailureRecord(value: unknown): OrderPaymentFailureRecord {
  try {
    const raw = exact(value, [
      "failureRecordReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "paymentTransactionReference",
      "paymentIntentReference",
      "paymentAttemptReference",
      "paymentEventReference",
      "reason",
      "retryDisposition",
      "terminalOccurredAt",
      "eventDigest",
    ]);
    if (
      !paymentFailureReasons.includes(raw.reason as never) ||
      !paymentRetryDispositions.includes(raw.retryDisposition as never)
    )
      return invalid();
    return Object.freeze({
      failureRecordReference: parseOrderingReference(raw.failureRecordReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      paymentTransactionReference: parseOrderingReference(raw.paymentTransactionReference),
      paymentIntentReference: parseOrderingReference(raw.paymentIntentReference),
      paymentAttemptReference: parseOrderingReference(raw.paymentAttemptReference),
      paymentEventReference: parseOrderingReference(raw.paymentEventReference),
      reason: raw.reason as OrderPaymentFailureRecord["reason"],
      retryDisposition: raw.retryDisposition as OrderPaymentFailureRecord["retryDisposition"],
      terminalOccurredAt: parseOrderingInstant(raw.terminalOccurredAt),
      eventDigest: parseOrderingHash(raw.eventDigest),
    });
  } catch (error) {
    if (error instanceof OrderPaymentOutcomeError) throw error;
    return invalid();
  }
}

function eventValue(event: PaymentOutcomeEnvelope) {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    producerModule: event.producerModule,
    tenantId: event.tenantId,
    storeId: event.storeId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: String(event.aggregateVersion),
    correlationId: event.correlationId,
    causationId: event.causationId,
    actor: { type: "System" },
    payload: { ...event.payload },
    redactionClassification: event.redactionClassification,
    replayMetadata: { replaySafe: true },
  };
}

export function createPaymentOutcomeEventBinding(value: unknown): string {
  return JSON.stringify({ event: eventValue(parsePaymentOutcomeEnvelope(value)) });
}

export function createOrderPaymentDispositionBinding(input: {
  readonly event: unknown;
  readonly disposition: unknown;
}): string {
  const event = parsePaymentSucceededEnvelope(input.event);
  const disposition = parseOrderPaymentOutcomeDisposition(input.disposition);
  const boundDisposition = Object.fromEntries(
    Object.entries(disposition).filter(([field]) => field !== "sourceDigest"),
  );
  return JSON.stringify({ event: eventValue(event), disposition: boundDisposition });
}
