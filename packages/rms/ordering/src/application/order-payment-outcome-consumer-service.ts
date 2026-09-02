import {
  consumeEventInTransaction,
  ConsumerTransactionRollback,
  type ConsumerOutcome,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";

import type { OrderConfirmedEnvelope } from "../contracts/order-confirmed-event.js";
import type {
  OrderPaymentFailureRecord,
  OrderPaymentOutcomeDisposition,
  OrderPaymentOutcomeResult,
  PaymentFailedEnvelope,
  PaymentOutcomeEnvelope,
  PaymentSucceededEnvelope,
} from "../contracts/order-payment-outcome.js";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import {
  createOrderConfirmedEnvelope,
  parseOrderConfirmedEnvelope,
} from "./order-confirmed-event.js";
import {
  createOrderPaymentDispositionBinding,
  createPaymentOutcomeEventBinding,
  OrderPaymentOutcomeError,
  parseOrderPaymentFailureRecord,
  parseOrderPaymentOutcomeDisposition,
  parsePaymentFailedEnvelope,
  parsePaymentOutcomeEnvelope,
  parsePaymentSucceededEnvelope,
} from "./order-payment-outcome.js";
import type {
  OrderPaymentOutcomeConsumerPorts,
  StoredOrderPaymentOutcomeEffect,
} from "./ports/order-payment-outcome-ports.js";

function failure(
  code:
    | "ORDER_PAYMENT_OUTCOME_PERMISSION_DENIED"
    | "ORDER_PAYMENT_OUTCOME_CONFLICT"
    | "ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE"
    | "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE",
): never {
  throw new OrderPaymentOutcomeError(code);
}

function dependency(): never {
  return failure("ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE");
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
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
      return dependency();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof OrderPaymentOutcomeError) throw error;
    return dependency();
  }
}

function parseRecord(value: unknown) {
  try {
    return parseOrderPaymentOutcomeDisposition(value);
  } catch (error) {
    if (
      !(error instanceof OrderPaymentOutcomeError) ||
      error.code !== "ORDER_PAYMENT_OUTCOME_INPUT_INVALID"
    )
      throw error;
  }
  try {
    return parseOrderPaymentFailureRecord(value);
  } catch {
    return dependency();
  }
}

function parseEffect(value: unknown): StoredOrderPaymentOutcomeEffect {
  const raw = exact(value, ["record", "orderConfirmedEvent"]);
  return Object.freeze({
    record: parseRecord(raw.record),
    orderConfirmedEvent:
      raw.orderConfirmedEvent === null
        ? null
        : parseOrderConfirmedEnvelope(raw.orderConfirmedEvent),
  });
}

function sha256(ports: OrderPaymentOutcomeConsumerPorts, canonicalValue: string) {
  try {
    return parseOrderingHash(ports.digests.sha256(canonicalValue));
  } catch {
    return dependency();
  }
}

function dispositionMatchesEvent(
  ports: OrderPaymentOutcomeConsumerPorts,
  event: PaymentSucceededEnvelope,
  disposition: OrderPaymentOutcomeDisposition,
): boolean {
  return (
    disposition.brandReference === event.tenantId &&
    disposition.storeReference === event.storeId &&
    disposition.orderReference === event.payload.orderReference &&
    disposition.paymentTransactionReference === event.payload.paymentTransactionReference &&
    disposition.paymentIntentReference === event.payload.paymentIntentReference &&
    disposition.paymentAttemptReference === event.payload.paymentAttemptReference &&
    disposition.paymentEventReference === event.eventId &&
    Date.parse(disposition.evaluatedAt) >= Date.parse(event.occurredAt) &&
    disposition.sourceDigest ===
      sha256(ports, createOrderPaymentDispositionBinding({ event, disposition }))
  );
}

function failureMatchesEvent(
  ports: OrderPaymentOutcomeConsumerPorts,
  event: PaymentFailedEnvelope,
  record: OrderPaymentFailureRecord,
): boolean {
  return (
    record.brandReference === event.tenantId &&
    record.storeReference === event.storeId &&
    record.orderReference === event.payload.orderReference &&
    record.paymentTransactionReference === event.payload.paymentTransactionReference &&
    record.paymentIntentReference === event.payload.paymentIntentReference &&
    record.paymentAttemptReference === event.payload.paymentAttemptReference &&
    record.paymentEventReference === event.eventId &&
    record.reason === event.payload.reason &&
    record.retryDisposition === event.payload.retryDisposition &&
    record.terminalOccurredAt === event.payload.terminalOccurredAt &&
    record.eventDigest === sha256(ports, createPaymentOutcomeEventBinding(event))
  );
}

function confirmedEventMatches(
  event: PaymentSucceededEnvelope,
  disposition: Extract<OrderPaymentOutcomeDisposition, { disposition: "Confirmed" }>,
  orderConfirmedEvent: OrderConfirmedEnvelope,
): boolean {
  return (
    orderConfirmedEvent.tenantId === disposition.brandReference &&
    orderConfirmedEvent.storeId === disposition.storeReference &&
    orderConfirmedEvent.aggregateId === disposition.orderReference &&
    orderConfirmedEvent.aggregateVersion === BigInt(disposition.sourceVersion) &&
    orderConfirmedEvent.correlationId === event.correlationId &&
    orderConfirmedEvent.causationId === event.eventId &&
    orderConfirmedEvent.payload.confirmationReference === disposition.confirmationReference &&
    orderConfirmedEvent.payload.orderReference === disposition.orderReference &&
    orderConfirmedEvent.payload.orderBatchReference === disposition.orderBatchReference &&
    orderConfirmedEvent.payload.sourceSnapshotDigest === disposition.sourceSnapshotDigest &&
    orderConfirmedEvent.payload.confirmedAt === disposition.confirmedAt
  );
}

function resultFromEffect(
  ports: OrderPaymentOutcomeConsumerPorts,
  event: PaymentOutcomeEnvelope,
  effect: StoredOrderPaymentOutcomeEffect,
  mismatchCode: "ORDER_PAYMENT_OUTCOME_CONFLICT" | "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE",
): OrderPaymentOutcomeResult {
  const record = effect.record;
  if (event.eventType === "PaymentSucceeded") {
    if (!("disposition" in record) || !dispositionMatchesEvent(ports, event, record))
      return failure(mismatchCode);
    if (record.disposition === "AwaitingAcceptance") return failure(mismatchCode);
    if (record.disposition === "PaidWithoutFulfillableOrder") {
      if (effect.orderConfirmedEvent !== null) return failure(mismatchCode);
      return Object.freeze({ status: "CompensationRequired" as const, disposition: record });
    }
    if (
      effect.orderConfirmedEvent === null ||
      !confirmedEventMatches(event, record, effect.orderConfirmedEvent)
    )
      return failure(mismatchCode);
    return Object.freeze({
      status: "OrderConfirmed" as const,
      disposition: record,
      orderConfirmedEventReference: parseOrderingReference(effect.orderConfirmedEvent.eventId),
    });
  }
  if (
    "disposition" in record ||
    effect.orderConfirmedEvent !== null ||
    !failureMatchesEvent(ports, event, record)
  )
    return failure(mismatchCode);
  return Object.freeze({ status: "PaymentFailedRecorded" as const, failure: record });
}

function parseCommit(value: unknown) {
  const raw = exact(value, ["status", "effect"]);
  if (raw.status !== "Created" && raw.status !== "AlreadyCommitted" && raw.status !== "Conflict")
    return dependency();
  if (raw.status === "Conflict") return Object.freeze({ status: raw.status });
  return Object.freeze({ status: raw.status, effect: parseEffect(raw.effect) });
}

function exactEffectMatches(
  attempted: StoredOrderPaymentOutcomeEffect,
  committed: StoredOrderPaymentOutcomeEffect,
  allowConcurrentGeneratedReferences: boolean,
): boolean {
  const comparable = (effect: StoredOrderPaymentOutcomeEffect) => {
    let record: unknown = effect.record;
    if (allowConcurrentGeneratedReferences && !("disposition" in effect.record)) {
      record = Object.fromEntries(
        Object.entries(effect.record).filter(([field]) => field !== "failureRecordReference"),
      );
    }
    let orderConfirmedEvent: unknown = effect.orderConfirmedEvent;
    if (allowConcurrentGeneratedReferences && effect.orderConfirmedEvent !== null) {
      orderConfirmedEvent = Object.fromEntries(
        Object.entries(effect.orderConfirmedEvent).filter(([field]) => field !== "eventId"),
      );
    }
    return { record, orderConfirmedEvent };
  };
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? String(item) : item,
    );
  return canonical(comparable(attempted)) === canonical(comparable(committed));
}

function registration(
  eventType: "PaymentSucceeded" | "PaymentFailed",
  handler: ConsumerRegistration["handler"],
): ConsumerRegistration {
  return Object.freeze({
    consumerName: "ordering.payment-outcome:v1",
    consumerVersion: 1,
    eventType,
    schemaVersions: Object.freeze([1]),
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect:
      "record the Ordering payment disposition and append OrderConfirmed only for Confirmed",
    replaySafe: true,
    handler,
  });
}

export function createOrderPaymentOutcomeConsumerService(ports: OrderPaymentOutcomeConsumerPorts) {
  async function authorize(event: PaymentOutcomeEnvelope) {
    let authorized;
    try {
      authorized = await ports.authorization.authorize({
        action: "ApplyPaymentOutcome",
        purpose: "ApplyAuthoritativePaymentOutcome",
        brandReference: parseOrderingReference(event.tenantId),
        storeReference: parseOrderingReference(event.storeId),
        orderReference: parseOrderingReference(event.payload.orderReference),
        paymentEventReference: parseOrderingReference(event.eventId),
        observedAt: parseOrderingInstant(event.occurredAt),
      });
    } catch {
      return dependency();
    }
    if (authorized !== true) return failure("ORDER_PAYMENT_OUTCOME_PERMISSION_DENIED");
  }

  async function loadEffect(event: PaymentOutcomeEnvelope, transaction: ConsumerTransaction) {
    try {
      const value = await ports.outcomes.loadByPaymentEvent({
        paymentEventReference: parseOrderingReference(event.eventId),
        transaction,
      });
      return value === null ? null : parseEffect(value);
    } catch (error) {
      if (error instanceof OrderPaymentOutcomeError) throw error;
      return dependency();
    }
  }

  async function processAuthorized(
    event: PaymentOutcomeEnvelope,
    transaction: ConsumerTransaction,
  ) {
    const existing = await loadEffect(event, transaction);
    if (existing !== null) {
      const result = resultFromEffect(ports, event, existing, "ORDER_PAYMENT_OUTCOME_CONFLICT");
      const digest =
        result.status === "PaymentFailedRecorded"
          ? result.failure.eventDigest
          : result.disposition.sourceDigest;
      return { status: "completed" as const, resultHash: digest.slice(7) };
    }

    if (event.eventType === "PaymentFailed") {
      let failureRecordReference;
      try {
        failureRecordReference = parseOrderingReference(
          ports.references.generate("PaymentFailureRecord"),
        );
      } catch {
        return dependency();
      }
      const failureRecord = parseOrderPaymentFailureRecord({
        failureRecordReference,
        brandReference: event.tenantId,
        storeReference: event.storeId,
        orderReference: event.payload.orderReference,
        paymentTransactionReference: event.payload.paymentTransactionReference,
        paymentIntentReference: event.payload.paymentIntentReference,
        paymentAttemptReference: event.payload.paymentAttemptReference,
        paymentEventReference: event.eventId,
        reason: event.payload.reason,
        retryDisposition: event.payload.retryDisposition,
        terminalOccurredAt: event.payload.terminalOccurredAt,
        eventDigest: sha256(ports, createPaymentOutcomeEventBinding(event)),
      });
      let committed;
      try {
        committed = parseCommit(
          await ports.outcomes.commitFailed({
            sourceEvent: event,
            failure: failureRecord,
            transaction,
          }),
        );
      } catch (error) {
        if (error instanceof OrderPaymentOutcomeError) throw error;
        return dependency();
      }
      if (committed.status === "Conflict") return failure("ORDER_PAYMENT_OUTCOME_CONFLICT");
      if (
        !exactEffectMatches(
          { record: failureRecord, orderConfirmedEvent: null },
          committed.effect,
          committed.status === "AlreadyCommitted",
        )
      )
        return failure(
          committed.status === "AlreadyCommitted"
            ? "ORDER_PAYMENT_OUTCOME_CONFLICT"
            : "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE",
        );
      const verifiedResult = resultFromEffect(
        ports,
        event,
        committed.effect,
        committed.status === "Created"
          ? "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE"
          : "ORDER_PAYMENT_OUTCOME_CONFLICT",
      );
      if (verifiedResult.status !== "PaymentFailedRecorded") return dependency();
      return {
        status: "completed" as const,
        resultHash: verifiedResult.failure.eventDigest.slice(7),
      };
    }

    let sourceValue;
    try {
      sourceValue = await ports.source.loadExact({
        brandReference: parseOrderingReference(event.tenantId),
        storeReference: parseOrderingReference(event.storeId),
        orderReference: parseOrderingReference(event.payload.orderReference),
        paymentTransactionReference: parseOrderingReference(
          event.payload.paymentTransactionReference,
        ),
        paymentIntentReference: parseOrderingReference(event.payload.paymentIntentReference),
        paymentAttemptReference: parseOrderingReference(event.payload.paymentAttemptReference),
        paymentEventReference: parseOrderingReference(event.eventId),
        paymentEvent: event,
      });
    } catch {
      return dependency();
    }
    if (sourceValue === null)
      return {
        status: "retry_required" as const,
        errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
      };
    let disposition;
    try {
      disposition = parseOrderPaymentOutcomeDisposition(sourceValue);
    } catch {
      return failure("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
    }
    if (!dispositionMatchesEvent(ports, event, disposition))
      return failure("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
    if (disposition.disposition === "AwaitingAcceptance")
      return {
        status: "retry_required" as const,
        errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
      };

    let orderConfirmedEvent: OrderConfirmedEnvelope | null = null;
    if (disposition.disposition === "Confirmed") {
      try {
        orderConfirmedEvent = createOrderConfirmedEnvelope({
          eventReference: ports.references.generate("OrderConfirmedEvent"),
          sourceEvent: event,
          disposition,
        });
      } catch {
        return failure("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
      }
    }
    let committed;
    try {
      committed = parseCommit(
        await ports.outcomes.commitSucceeded({
          sourceEvent: event,
          disposition,
          orderConfirmedEvent,
          transaction,
        }),
      );
    } catch (error) {
      if (error instanceof OrderPaymentOutcomeError) throw error;
      return dependency();
    }
    if (committed.status === "Conflict") return failure("ORDER_PAYMENT_OUTCOME_CONFLICT");
    if (
      !exactEffectMatches(
        { record: disposition, orderConfirmedEvent },
        committed.effect,
        committed.status === "AlreadyCommitted",
      )
    )
      return failure(
        committed.status === "AlreadyCommitted"
          ? "ORDER_PAYMENT_OUTCOME_CONFLICT"
          : "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE",
      );
    const verifiedResult = resultFromEffect(
      ports,
      event,
      committed.effect,
      committed.status === "Created"
        ? "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE"
        : "ORDER_PAYMENT_OUTCOME_CONFLICT",
    );
    if (verifiedResult.status === "PaymentFailedRecorded") return dependency();
    return {
      status: "completed" as const,
      resultHash: verifiedResult.disposition.sourceDigest.slice(7),
    };
  }

  const registrations = Object.freeze([
    registration("PaymentSucceeded", async ({ envelope, transaction }) => {
      const event = parsePaymentSucceededEnvelope(envelope);
      await authorize(event);
      return processAuthorized(event, transaction);
    }),
    registration("PaymentFailed", async ({ envelope, transaction }) => {
      const event = parsePaymentFailedEnvelope(envelope);
      await authorize(event);
      return processAuthorized(event, transaction);
    }),
  ]);

  return Object.freeze({
    registrations,
    async consume(
      transaction: ConsumerTransaction,
      value: unknown,
    ): Promise<{
      readonly consumerOutcome: ConsumerOutcome;
      readonly result: OrderPaymentOutcomeResult;
    }> {
      const event = parsePaymentOutcomeEnvelope(value);
      await authorize(event);
      const existing = await loadEffect(event, transaction);
      if (existing !== null)
        resultFromEffect(ports, event, existing, "ORDER_PAYMENT_OUTCOME_CONFLICT");
      const selected = registrations.find((item) => item.eventType === event.eventType);
      if (selected === undefined) return dependency();
      const authorizedRegistration: ConsumerRegistration = {
        consumerName: selected.consumerName,
        consumerVersion: selected.consumerVersion,
        eventType: selected.eventType,
        schemaVersions: selected.schemaVersions,
        ownerModule: selected.ownerModule,
        tenantScope: selected.tenantScope,
        ordering: selected.ordering,
        sideEffect: selected.sideEffect,
        replaySafe: selected.replaySafe,
        handler: ({ envelope, transaction: handlerTransaction }) =>
          processAuthorized(parsePaymentOutcomeEnvelope(envelope), handlerTransaction),
      };
      let consumerOutcome;
      try {
        consumerOutcome = await consumeEventInTransaction(
          transaction,
          authorizedRegistration,
          event,
        );
      } catch (error) {
        if (error instanceof ConsumerTransactionRollback) throw error;
        if (error instanceof OrderPaymentOutcomeError) throw error;
        return dependency();
      }
      if (consumerOutcome.status === "rejected") return failure("ORDER_PAYMENT_OUTCOME_CONFLICT");
      if (consumerOutcome.status === "retry_required")
        throw new ConsumerTransactionRollback(consumerOutcome);
      const stored = await loadEffect(event, transaction);
      if (stored === null) return dependency();
      return Object.freeze({
        consumerOutcome,
        result: resultFromEffect(
          ports,
          event,
          stored,
          "ORDER_PAYMENT_OUTCOME_DEPENDENCY_UNAVAILABLE",
        ),
      });
    },
  });
}
