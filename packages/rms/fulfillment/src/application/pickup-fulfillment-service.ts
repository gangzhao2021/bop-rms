import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  consumeEventInTransaction,
  ConsumerTransactionRollback,
  type ConsumerOutcome,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import {
  createOrderFulfillmentSourceEvidenceBinding,
  createOrderFulfillmentSourceLineBinding,
  OrderFulfillmentSourceError,
  parseConfirmedOrderFulfillmentSourceEvidence,
  parseOrderConfirmedEnvelope,
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type ConfirmedOrderFulfillmentSourceEvidence,
  type OrderConfirmedEnvelope,
} from "@rms/ordering";

import {
  pickupFulfillmentAuditRetentionPolicyCode,
  pickupFulfillmentAuditRetentionPolicyVersion,
  pickupFulfillmentConsumerName,
  pickupFulfillmentConsumerVersion,
  PickupFulfillmentError,
  type FulfillmentDigest,
  type FulfillmentReference,
  type PickupFulfillmentAggregate,
  type PickupFulfillmentCreationEffect,
  type PickupFulfillmentCreationResult,
} from "../contracts/pickup-fulfillment.js";
import {
  canonicalFulfillmentValue,
  createPickupFulfillmentSemanticBinding,
  parseFulfillmentDigest,
  parseFulfillmentInstant,
  parseFulfillmentReference,
  parsePickupFulfillmentAggregate,
  parsePickupFulfillmentCreationEffect,
  parsePickupFulfillmentCreationOperation,
} from "../domain/pickup-fulfillment.js";
import type {
  PickupFulfillmentCommit,
  PickupFulfillmentPorts,
  PickupFulfillmentResolution,
} from "./ports/pickup-fulfillment-ports.js";

function fail(code: ConstructorParameters<typeof PickupFulfillmentError>[0]): never {
  throw new PickupFulfillmentError(code);
}

function invalid(): never {
  return fail("PICKUP_FULFILLMENT_INPUT_INVALID");
}

function conflict(): never {
  return fail("PICKUP_FULFILLMENT_CONFLICT");
}

function dependency(): never {
  return fail("PICKUP_FULFILLMENT_DEPENDENCY_UNAVAILABLE");
}

function portObject(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return dependency();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return dependency();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof PickupFulfillmentError) throw error;
    return dependency();
  }
}

function portStatus(value: unknown): unknown {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return dependency();
    const descriptor = Object.getOwnPropertyDescriptor(value, "status");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !descriptor.enumerable
    )
      return dependency();
    return descriptor.value;
  } catch (error) {
    if (error instanceof PickupFulfillmentError) throw error;
    return dependency();
  }
}

function sourceEvent(value: unknown): OrderConfirmedEnvelope {
  try {
    return parseOrderConfirmedEnvelope(value);
  } catch {
    return invalid();
  }
}

function digest(ports: PickupFulfillmentPorts, value: string): FulfillmentDigest {
  try {
    return parseFulfillmentDigest(ports.digests.sha256(value));
  } catch {
    return dependency();
  }
}

function reference(
  ports: PickupFulfillmentPorts,
  purpose: Parameters<PickupFulfillmentPorts["references"]["derive"]>[0],
  identity: unknown,
): FulfillmentReference {
  try {
    return parseFulfillmentReference(
      ports.references.derive(purpose, canonicalFulfillmentValue(identity)),
    );
  } catch {
    return dependency();
  }
}

async function authorize(
  ports: PickupFulfillmentPorts,
  event: OrderConfirmedEnvelope,
): Promise<void> {
  let authorized: boolean;
  try {
    authorized = await ports.authorization.authorize({
      action: "ConsumeConfirmedOrder",
      purpose: "CreatePickupFulfillment",
      brandReference: parseFulfillmentReference(event.tenantId),
      storeReference: parseFulfillmentReference(event.storeId),
      orderReference: parseFulfillmentReference(event.payload.orderReference),
      orderBatchReference: parseFulfillmentReference(event.payload.orderBatchReference),
      confirmationReference: parseFulfillmentReference(event.payload.confirmationReference),
      sourceEventReference: parseFulfillmentReference(event.eventId),
      observedAt: parseFulfillmentInstant(event.occurredAt),
    });
  } catch {
    return dependency();
  }
  if (!authorized) return fail("PICKUP_FULFILLMENT_PERMISSION_DENIED");
}

function mapOrderingFailure(error: unknown): never {
  if (error instanceof OrderFulfillmentSourceError) {
    if (error.code === "ORDER_FULFILLMENT_SOURCE_PERMISSION_DENIED")
      return fail("PICKUP_FULFILLMENT_PERMISSION_DENIED");
    if (
      error.code === "ORDER_FULFILLMENT_SOURCE_CONFLICT" ||
      error.code === "ORDER_FULFILLMENT_SOURCE_INPUT_INVALID"
    )
      return conflict();
  }
  return dependency();
}

async function resolveSource(
  ports: PickupFulfillmentPorts,
  event: OrderConfirmedEnvelope,
): Promise<ConfirmedOrderFulfillmentSourceEvidence> {
  let value: unknown;
  try {
    value = await ports.orderingSource.resolve({
      brandReference: parseOrderingReference(event.tenantId),
      storeReference: parseOrderingReference(event.storeId),
      orderReference: parseOrderingReference(event.payload.orderReference),
      orderBatchReference: parseOrderingReference(event.payload.orderBatchReference),
      confirmationReference: parseOrderingReference(event.payload.confirmationReference),
      sourceEventReference: parseOrderingReference(event.eventId),
      sourceAggregateVersion: event.aggregateVersion,
      sourceSnapshotDigest: parseOrderingHash(event.payload.sourceSnapshotDigest),
      observedAt: parseOrderingInstant(event.occurredAt),
    });
  } catch (error) {
    return mapOrderingFailure(error);
  }
  let source: ConfirmedOrderFulfillmentSourceEvidence;
  try {
    source = parseConfirmedOrderFulfillmentSourceEvidence(value);
  } catch {
    return conflict();
  }
  if (
    source.brandReference !== event.tenantId ||
    source.storeReference !== event.storeId ||
    source.orderReference !== event.payload.orderReference ||
    source.orderBatchReference !== event.payload.orderBatchReference ||
    source.confirmationReference !== event.payload.confirmationReference ||
    source.sourceEventReference !== event.eventId ||
    source.sourceAggregateVersion !== event.aggregateVersion ||
    source.sourceSnapshotDigest !== event.payload.sourceSnapshotDigest ||
    Date.parse(source.capturedAt) > Date.parse(event.occurredAt)
  )
    return conflict();
  if (
    source.items.some(
      (entry) =>
        String(digest(ports, createOrderFulfillmentSourceLineBinding(entry))) !==
        String(entry.lineDigest),
    ) ||
    String(digest(ports, createOrderFulfillmentSourceEvidenceBinding(source))) !==
      String(source.evidenceDigest)
  )
    return conflict();
  return source;
}

function createAudit(
  ports: PickupFulfillmentPorts,
  aggregate: PickupFulfillmentAggregate,
): AppendAuditRecordInput {
  const candidate: AppendAuditRecordInput = Object.freeze({
    auditId: reference(ports, "PickupFulfillmentAudit", {
      fulfillmentReference: aggregate.fulfillmentReference,
      action: "PICKUP_FULFILLMENT_CREATED",
    }),
    brandId: aggregate.brandReference,
    storeId: aggregate.storeReference,
    actor: Object.freeze({ type: "System" as const }),
    actionCode: "PICKUP_FULFILLMENT_CREATED",
    targetType: "Fulfillment",
    targetId: aggregate.fulfillmentReference,
    afterSummary: Object.freeze({
      canonicalPhase: "Pending",
      itemCount: aggregate.items.length,
    }),
    reasonCode: "ORDER_CONFIRMED",
    correlationId: aggregate.correlationReference,
    occurredAt: aggregate.createdAt,
    sourceChannel: "EVENT_CONSUMER",
    dataClassification: "Confidential",
    retentionPolicyCode: pickupFulfillmentAuditRetentionPolicyCode,
    retentionPolicyVersion: pickupFulfillmentAuditRetentionPolicyVersion,
  });
  try {
    return validateAuditRecord(candidate, Date.parse(aggregate.createdAt));
  } catch {
    return dependency();
  }
}

function buildEffect(
  ports: PickupFulfillmentPorts,
  event: OrderConfirmedEnvelope,
  source: ConfirmedOrderFulfillmentSourceEvidence,
): PickupFulfillmentCreationEffect {
  if (source.orderType !== "Pickup") return fail("PICKUP_FULFILLMENT_NOT_APPLICABLE");
  const fulfillmentReference = reference(ports, "PickupFulfillment", {
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    orderReference: source.orderReference,
  });
  const aggregate = parsePickupFulfillmentAggregate({
    fulfillmentReference,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    orderReference: source.orderReference,
    orderBatchReference: source.orderBatchReference,
    confirmationReference: source.confirmationReference,
    sourceEventReference: source.sourceEventReference,
    sourceAggregateVersion: source.sourceAggregateVersion,
    sourceSnapshotDigest: source.sourceSnapshotDigest,
    sourceEvidenceReference: source.evidenceReference,
    sourceEvidenceVersion: source.evidenceVersion,
    sourceEvidenceDigest: source.evidenceDigest,
    fulfillmentType: "Pickup",
    canonicalPhase: "Pending",
    aggregateVersion: 1,
    createdAt: event.occurredAt,
    correlationReference: event.correlationId,
    items: source.items.map((entry) => ({
      fulfillmentItemReference: reference(ports, "PickupFulfillmentItem", {
        fulfillmentReference,
        orderItemReference: entry.orderItemReference,
      }),
      orderItemReference: entry.orderItemReference,
      ordinal: entry.ordinal,
      orderedQuantity: entry.quantity,
      readyQuantity: 0,
      handedOverQuantity: 0,
      state: "Pending",
      sourceLineDigest: entry.lineDigest,
    })),
  });
  const semanticBindingDigest = digest(ports, createPickupFulfillmentSemanticBinding(aggregate));
  const operation = parsePickupFulfillmentCreationOperation({
    operationReference: reference(ports, "PickupFulfillmentOperation", {
      fulfillmentReference,
      confirmationReference: source.confirmationReference,
    }),
    fulfillmentReference,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    sourceEventReference: source.sourceEventReference,
    confirmationReference: source.confirmationReference,
    orderReference: source.orderReference,
    sourceEvidenceDigest: source.evidenceDigest,
    semanticBindingDigest,
    occurredAt: event.occurredAt,
  });
  const audit = createAudit(ports, aggregate);
  const withoutDigest = Object.freeze({ aggregate, operation, audit });
  return parsePickupFulfillmentCreationEffect({
    ...withoutDigest,
    effectDigest: digest(ports, canonicalFulfillmentValue(withoutDigest)),
  });
}

function verifyEffect(
  ports: PickupFulfillmentPorts,
  value: unknown,
  attempted: PickupFulfillmentCreationEffect,
): PickupFulfillmentCreationEffect {
  let effect: PickupFulfillmentCreationEffect;
  try {
    effect = parsePickupFulfillmentCreationEffect(value);
  } catch {
    return dependency();
  }
  if (
    digest(
      ports,
      canonicalFulfillmentValue({
        aggregate: effect.aggregate,
        operation: effect.operation,
        audit: effect.audit,
      }),
    ) !== effect.effectDigest
  )
    return dependency();
  const left = effect.aggregate;
  const right = attempted.aggregate;
  if (
    left.fulfillmentReference !== right.fulfillmentReference ||
    left.brandReference !== right.brandReference ||
    left.storeReference !== right.storeReference ||
    left.orderReference !== right.orderReference ||
    left.orderBatchReference !== right.orderBatchReference ||
    left.confirmationReference !== right.confirmationReference ||
    left.sourceAggregateVersion !== right.sourceAggregateVersion ||
    left.sourceSnapshotDigest !== right.sourceSnapshotDigest ||
    left.fulfillmentType !== right.fulfillmentType ||
    left.canonicalPhase !== right.canonicalPhase ||
    left.aggregateVersion !== right.aggregateVersion ||
    left.createdAt !== right.createdAt ||
    left.correlationReference !== right.correlationReference ||
    effect.operation.semanticBindingDigest !== attempted.operation.semanticBindingDigest ||
    canonicalFulfillmentValue(left.items) !== canonicalFulfillmentValue(right.items)
  )
    return conflict();
  return effect;
}

function resolution(value: unknown): PickupFulfillmentResolution {
  const status = portStatus(value);
  if (status === "NotFound" || status === "Conflict") {
    return Object.freeze({ status });
  }
  const resolved = portObject(value, ["status", "effect"]);
  if (resolved.status !== "Resolved") return dependency();
  return Object.freeze({
    status: "Resolved" as const,
    effect: resolved.effect,
  });
}

function commit(value: unknown): PickupFulfillmentCommit {
  const status = portStatus(value);
  if (status === "Conflict") {
    portObject(value, ["status"]);
    return Object.freeze({ status });
  }
  const committed = portObject(value, ["status", "effect"]);
  if (committed.status !== "Created" && committed.status !== "AlreadyCreated") return dependency();
  return Object.freeze({ status: committed.status, effect: committed.effect });
}

async function resolveExisting(
  ports: PickupFulfillmentPorts,
  attempted: PickupFulfillmentCreationEffect,
  transaction: ConsumerTransaction,
): Promise<PickupFulfillmentCreationEffect | null> {
  let result: PickupFulfillmentResolution;
  try {
    result = resolution(
      await ports.repository.resolveByOrder({
        brandReference: attempted.aggregate.brandReference,
        storeReference: attempted.aggregate.storeReference,
        orderReference: attempted.aggregate.orderReference,
        transaction,
      }),
    );
  } catch (error) {
    if (error instanceof PickupFulfillmentError) throw error;
    return dependency();
  }
  if (result.status === "Conflict") return conflict();
  if (result.status === "NotFound") return null;
  return verifyEffect(ports, result.effect, attempted);
}

async function create(
  ports: PickupFulfillmentPorts,
  attempted: PickupFulfillmentCreationEffect,
  transaction: ConsumerTransaction,
): Promise<PickupFulfillmentCreationResult> {
  let result: PickupFulfillmentCommit;
  try {
    result = commit(await ports.repository.create({ effect: attempted, transaction }));
  } catch (error) {
    if (error instanceof PickupFulfillmentError) throw error;
    return dependency();
  }
  if (result.status === "Conflict") return conflict();
  const persisted = verifyEffect(ports, result.effect, attempted);
  if (result.status === "Created") {
    try {
      await ports.audit.append({ record: persisted.audit, transaction });
    } catch {
      return dependency();
    }
  }
  return Object.freeze({ status: result.status, effect: persisted });
}

function handlerFailure(error: unknown) {
  if (
    error instanceof PickupFulfillmentError &&
    error.code !== "PICKUP_FULFILLMENT_DEPENDENCY_UNAVAILABLE"
  )
    return { status: "rejected" as const, errorCode: "CONSUMER_REJECTED" as const };
  return {
    status: "retry_required" as const,
    errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
  };
}

export function createPickupFulfillmentService(ports: PickupFulfillmentPorts) {
  async function process(event: OrderConfirmedEnvelope, transaction: ConsumerTransaction) {
    await authorize(ports, event);
    const source = await resolveSource(ports, event);
    if (source.orderType !== "Pickup") return Object.freeze({ status: "NotApplicable" as const });
    const attempted = buildEffect(ports, event, source);
    const existing = await resolveExisting(ports, attempted, transaction);
    if (existing !== null)
      return Object.freeze({ status: "AlreadyCreated" as const, effect: existing });
    return create(ports, attempted, transaction);
  }

  const registration: ConsumerRegistration = Object.freeze({
    consumerName: pickupFulfillmentConsumerName,
    consumerVersion: pickupFulfillmentConsumerVersion,
    eventType: "OrderConfirmed",
    schemaVersions: Object.freeze([1]),
    ownerModule: "@rms/fulfillment",
    tenantScope: "store",
    ordering: "none",
    sideEffect: "create_pickup_fulfillment",
    replaySafe: true,
    handler: async ({ envelope, transaction }: Parameters<ConsumerRegistration["handler"]>[0]) => {
      try {
        const result = await process(sourceEvent(envelope), transaction);
        return result.status === "NotApplicable"
          ? { status: "completed" as const }
          : { status: "completed" as const, resultHash: result.effect.effectDigest.slice(7) };
      } catch (error) {
        return handlerFailure(error);
      }
    },
  });

  return Object.freeze({
    registration,
    async consume(
      transaction: ConsumerTransaction,
      value: unknown,
    ): Promise<PickupFulfillmentCreationResult> {
      const event = sourceEvent(value);
      await authorize(ports, event);
      const source = await resolveSource(ports, event);
      const notApplicable = source.orderType !== "Pickup";
      const attempted = notApplicable ? null : buildEffect(ports, event, source);
      const preflight =
        attempted === null ? null : await resolveExisting(ports, attempted, transaction);
      let execution: PickupFulfillmentCreationResult | undefined;
      const authorizedRegistration: ConsumerRegistration = Object.freeze({
        ...registration,
        handler: async ({
          transaction: handlerTransaction,
        }: Parameters<ConsumerRegistration["handler"]>[0]) => {
          if (attempted === null) {
            execution = Object.freeze({ status: "NotApplicable" as const });
            return { status: "completed" as const };
          }
          execution =
            preflight === null
              ? await create(ports, attempted, handlerTransaction)
              : Object.freeze({ status: "AlreadyCreated" as const, effect: preflight });
          if (execution.status === "NotApplicable") return dependency();
          return {
            status: "completed" as const,
            resultHash: execution.effect.effectDigest.slice(7),
          };
        },
      });
      let outcome: ConsumerOutcome;
      try {
        outcome = await consumeEventInTransaction(transaction, authorizedRegistration, event);
      } catch (error) {
        if (error instanceof PickupFulfillmentError) throw error;
        if (error instanceof ConsumerTransactionRollback)
          return error.outcome.status === "rejected" ? conflict() : dependency();
        return dependency();
      }
      if (outcome.status === "rejected" || outcome.status === "retry_required") return dependency();
      if (attempted === null) return Object.freeze({ status: "NotApplicable" as const });
      const postcondition = await resolveExisting(ports, attempted, transaction);
      if (postcondition === null) return dependency();
      if (outcome.status === "processed" && execution === undefined) return dependency();
      if (preflight !== null && execution?.status === "Created") return dependency();
      return Object.freeze({
        status: execution?.status === "Created" ? "Created" : "AlreadyCreated",
        effect: postcondition,
      });
    },
  });
}
