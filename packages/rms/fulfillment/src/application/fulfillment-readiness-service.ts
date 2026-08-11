import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import {
  consumeEventInTransaction,
  ConsumerTransactionRollback,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import { parseKitchenItemReadyEnvelope, type KitchenItemReadyEnvelope } from "@rms/kitchen";

import {
  canonicalReadinessValue,
  fulfillmentItemReadyConsumerName,
  fulfillmentItemReadyConsumerVersion,
  FulfillmentReadinessError,
  parseFulfillmentReadinessSource,
  parseFulfillmentReadyEffect,
  parseReadinessDigest,
  parseReadinessInstant,
  parseReadinessReference,
  type FulfillmentReadinessSource,
  type FulfillmentReadyEffect,
  type FulfillmentReadyResult,
  type ReadinessDigest,
  type ReadinessReference,
} from "../contracts/fulfillment-readiness.js";
import type {
  FulfillmentReadinessCommit,
  FulfillmentReadinessPorts,
  FulfillmentReadinessResolution,
} from "./ports/fulfillment-readiness-ports.js";

function fail(code: ConstructorParameters<typeof FulfillmentReadinessError>[0]): never {
  throw new FulfillmentReadinessError(code);
}

function invalid(): never {
  return fail("FULFILLMENT_READINESS_INPUT_INVALID");
}

function conflict(): never {
  return fail("FULFILLMENT_READINESS_CONFLICT");
}

function dependency(): never {
  return fail("FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE");
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
    return Object.freeze(
      Object.fromEntries(
        fields.map((field) => {
          const descriptor = descriptors[field];
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            !descriptor.enumerable
          )
            return dependency();
          return [field, descriptor.value];
        }),
      ),
    );
  } catch (error) {
    if (error instanceof FulfillmentReadinessError) throw error;
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
    if (error instanceof FulfillmentReadinessError) throw error;
    return dependency();
  }
}

function event(value: unknown): KitchenItemReadyEnvelope {
  try {
    return parseKitchenItemReadyEnvelope(value);
  } catch {
    return invalid();
  }
}

function reference(
  ports: FulfillmentReadinessPorts,
  purpose: Parameters<FulfillmentReadinessPorts["references"]["derive"]>[0],
  identity: unknown,
): ReadinessReference {
  try {
    return parseReadinessReference(
      ports.references.derive(purpose, canonicalReadinessValue(identity)),
    );
  } catch {
    return dependency();
  }
}

function digest(ports: FulfillmentReadinessPorts, value: string): ReadinessDigest {
  try {
    return parseReadinessDigest(ports.digests.sha256(value));
  } catch {
    return dependency();
  }
}

function semanticBinding(effect: FulfillmentReadyEffect): string {
  return canonicalReadinessValue({
    fulfillmentReference: effect.result.fulfillmentReference,
    fulfillmentItemReference: effect.result.fulfillmentItemReference,
    orderReference: effect.result.orderReference,
    orderBatchReference: effect.result.orderBatchReference,
    orderItemReference: effect.result.orderItemReference,
    kitchenTicketReference: effect.result.kitchenTicketReference,
    kitchenReadyResultReference: effect.result.kitchenReadyResultReference,
    readyQuantity: effect.result.readyQuantity,
    aggregateVersionBefore: effect.operation.aggregateVersionBefore,
    aggregateVersionAfter: effect.operation.aggregateVersionAfter,
    phaseBefore: effect.operation.phaseBefore,
    phaseAfter: effect.operation.phaseAfter,
    occurredAt: effect.result.occurredAt,
  });
}

async function authorize(
  ports: FulfillmentReadinessPorts,
  sourceEvent: KitchenItemReadyEnvelope,
): Promise<void> {
  let authorized: boolean;
  try {
    authorized = await ports.authorization.authorize({
      action: "ConsumeKitchenItemReady",
      purpose: "RecordFulfillmentItemReady",
      brandReference: parseReadinessReference(sourceEvent.tenantId),
      storeReference: parseReadinessReference(sourceEvent.storeId),
      orderReference: parseReadinessReference(sourceEvent.payload.orderReference),
      orderBatchReference: parseReadinessReference(sourceEvent.payload.orderBatchReference),
      orderItemReference: parseReadinessReference(sourceEvent.payload.orderItemReference),
      sourceEventReference: parseReadinessReference(sourceEvent.eventId),
      observedAt: parseReadinessInstant(sourceEvent.occurredAt),
    });
  } catch {
    return dependency();
  }
  if (!authorized) return fail("FULFILLMENT_READINESS_PERMISSION_DENIED");
}

function resolution(value: unknown): FulfillmentReadinessResolution {
  const status = portStatus(value);
  if (status === "NotFound" || status === "Conflict") {
    portObject(value, ["status"]);
    return Object.freeze({ status });
  }
  const raw = portObject(value, ["status", "effect"]);
  if (raw.status !== "Resolved") return dependency();
  return Object.freeze({ status: "Resolved" as const, effect: raw.effect });
}

function committed(value: unknown): FulfillmentReadinessCommit {
  const status = portStatus(value);
  if (status === "Conflict") {
    portObject(value, ["status"]);
    return Object.freeze({ status: "Conflict" as const });
  }
  const raw = portObject(value, ["status", "effect"]);
  if (raw.status !== "Applied" && raw.status !== "AlreadyApplied") return dependency();
  return Object.freeze({ status: raw.status, effect: raw.effect });
}

function verifyEventEffect(
  ports: FulfillmentReadinessPorts,
  value: unknown,
  sourceEvent: KitchenItemReadyEnvelope,
): FulfillmentReadyEffect {
  let effect: FulfillmentReadyEffect;
  try {
    effect = parseFulfillmentReadyEffect(value);
  } catch {
    return dependency();
  }
  if (
    digest(
      ports,
      canonicalReadinessValue({
        result: effect.result,
        operation: effect.operation,
        audit: effect.audit,
      }),
    ) !== effect.effectDigest
  )
    return dependency();
  if (digest(ports, semanticBinding(effect)) !== effect.operation.semanticBindingDigest)
    return dependency();
  if (
    effect.operation.brandReference !== sourceEvent.tenantId ||
    effect.operation.storeReference !== sourceEvent.storeId ||
    effect.result.orderReference !== sourceEvent.payload.orderReference ||
    effect.result.orderBatchReference !== sourceEvent.payload.orderBatchReference ||
    effect.result.orderItemReference !== sourceEvent.payload.orderItemReference ||
    effect.result.kitchenTicketReference !== sourceEvent.payload.kitchenTicketReference ||
    effect.result.kitchenReadyResultReference !== sourceEvent.payload.readyResultReference ||
    effect.result.readyQuantity !== sourceEvent.payload.readyQuantity ||
    effect.result.occurredAt !== sourceEvent.payload.readyAt
  )
    return conflict();
  return effect;
}

async function resolveExisting(
  ports: FulfillmentReadinessPorts,
  sourceEvent: KitchenItemReadyEnvelope,
  transaction: ConsumerTransaction,
): Promise<FulfillmentReadyEffect | null> {
  let result: FulfillmentReadinessResolution;
  try {
    result = resolution(
      await ports.repository.resolveByKitchenReadyResult({
        brandReference: parseReadinessReference(sourceEvent.tenantId),
        storeReference: parseReadinessReference(sourceEvent.storeId),
        kitchenReadyResultReference: parseReadinessReference(
          sourceEvent.payload.readyResultReference,
        ),
        transaction,
      }),
    );
  } catch (error) {
    if (error instanceof FulfillmentReadinessError) throw error;
    return dependency();
  }
  if (result.status === "Conflict") return conflict();
  if (result.status === "NotFound") return null;
  return verifyEventEffect(ports, result.effect, sourceEvent);
}

async function lockSource(
  ports: FulfillmentReadinessPorts,
  sourceEvent: KitchenItemReadyEnvelope,
  transaction: ConsumerTransaction,
): Promise<FulfillmentReadinessSource> {
  let value: unknown;
  try {
    value = await ports.repository.lockByOrder({
      brandReference: parseReadinessReference(sourceEvent.tenantId),
      storeReference: parseReadinessReference(sourceEvent.storeId),
      orderReference: parseReadinessReference(sourceEvent.payload.orderReference),
      transaction,
    });
  } catch {
    return dependency();
  }
  if (value === null) return fail("FULFILLMENT_READINESS_NOT_FOUND");
  try {
    return parseFulfillmentReadinessSource(value);
  } catch {
    return conflict();
  }
}

function audit(
  ports: FulfillmentReadinessPorts,
  source: FulfillmentReadinessSource,
  sourceEvent: KitchenItemReadyEnvelope,
  itemReference: ReadinessReference,
): AppendAuditRecordInput {
  const candidate: AppendAuditRecordInput = Object.freeze({
    auditId: reference(ports, "FulfillmentReadyAudit", {
      itemReference,
      kitchenReadyResultReference: sourceEvent.payload.readyResultReference,
    }),
    brandId: source.brandReference,
    storeId: source.storeReference,
    actor: Object.freeze({ type: "System" as const }),
    actionCode: "FULFILLMENT_ITEM_READY_RECORDED",
    targetType: "FulfillmentItem",
    targetId: itemReference,
    beforeSummary: Object.freeze({ state: "Pending", readyQuantity: 0 }),
    afterSummary: Object.freeze({
      state: "Ready",
      readyQuantity: sourceEvent.payload.readyQuantity,
    }),
    reasonCode: "KITCHEN_ITEM_READY",
    correlationId: sourceEvent.correlationId,
    occurredAt: sourceEvent.occurredAt,
    sourceChannel: "EVENT_CONSUMER",
    dataClassification: "Confidential",
    retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
    retentionPolicyVersion: 1,
  });
  try {
    return validateAuditRecord(candidate, Date.parse(source.lockedAt));
  } catch {
    return dependency();
  }
}

function buildEffect(
  ports: FulfillmentReadinessPorts,
  source: FulfillmentReadinessSource,
  sourceEvent: KitchenItemReadyEnvelope,
): FulfillmentReadyEffect {
  if (
    source.brandReference !== sourceEvent.tenantId ||
    source.storeReference !== sourceEvent.storeId ||
    source.orderReference !== sourceEvent.payload.orderReference ||
    source.orderBatchReference !== sourceEvent.payload.orderBatchReference ||
    Date.parse(sourceEvent.payload.readyAt) > Date.parse(source.lockedAt)
  )
    return conflict();
  const item = source.items.find(
    (entry) => entry.orderItemReference === sourceEvent.payload.orderItemReference,
  );
  if (item === undefined) return fail("FULFILLMENT_READINESS_NOT_FOUND");
  if (
    item.state !== "Pending" ||
    item.readyQuantity !== 0 ||
    sourceEvent.payload.readyQuantity !== item.orderedQuantity ||
    sourceEvent.payload.requiredQuantity !== item.orderedQuantity
  )
    return conflict();
  const phaseAfter = source.items.every(
    (entry) => entry.orderItemReference === item.orderItemReference || entry.state === "Ready",
  )
    ? "Ready"
    : "Pending";
  const result = Object.freeze({
    resultReference: reference(ports, "FulfillmentReadyResult", {
      fulfillmentReference: source.fulfillmentReference,
      kitchenReadyResultReference: sourceEvent.payload.readyResultReference,
    }),
    fulfillmentReference: source.fulfillmentReference,
    fulfillmentItemReference: item.fulfillmentItemReference,
    orderReference: source.orderReference,
    orderBatchReference: source.orderBatchReference,
    orderItemReference: item.orderItemReference,
    kitchenTicketReference: parseReadinessReference(sourceEvent.payload.kitchenTicketReference),
    kitchenReadyResultReference: parseReadinessReference(sourceEvent.payload.readyResultReference),
    sourceEventReference: parseReadinessReference(sourceEvent.eventId),
    readyQuantity: item.orderedQuantity,
    occurredAt: parseReadinessInstant(sourceEvent.occurredAt),
  });
  const semanticBindingDigest = digest(
    ports,
    canonicalReadinessValue({
      fulfillmentReference: source.fulfillmentReference,
      fulfillmentItemReference: item.fulfillmentItemReference,
      orderReference: source.orderReference,
      orderBatchReference: source.orderBatchReference,
      orderItemReference: item.orderItemReference,
      kitchenTicketReference: sourceEvent.payload.kitchenTicketReference,
      kitchenReadyResultReference: sourceEvent.payload.readyResultReference,
      readyQuantity: item.orderedQuantity,
      aggregateVersionBefore: source.aggregateVersion,
      aggregateVersionAfter: source.aggregateVersion + 1n,
      phaseBefore: source.canonicalPhase,
      phaseAfter,
      occurredAt: sourceEvent.occurredAt,
    }),
  );
  const operation = Object.freeze({
    operationReference: reference(ports, "FulfillmentReadyOperation", {
      fulfillmentReference: source.fulfillmentReference,
      kitchenReadyResultReference: sourceEvent.payload.readyResultReference,
    }),
    fulfillmentReference: source.fulfillmentReference,
    fulfillmentItemReference: item.fulfillmentItemReference,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    sourceEventReference: parseReadinessReference(sourceEvent.eventId),
    kitchenReadyResultReference: parseReadinessReference(sourceEvent.payload.readyResultReference),
    aggregateVersionBefore: source.aggregateVersion,
    aggregateVersionAfter: source.aggregateVersion + 1n,
    phaseBefore: source.canonicalPhase,
    phaseAfter,
    semanticBindingDigest,
    occurredAt: parseReadinessInstant(sourceEvent.occurredAt),
  });
  const auditRecord = audit(ports, source, sourceEvent, item.fulfillmentItemReference);
  const references = [
    result.resultReference,
    result.fulfillmentReference,
    result.fulfillmentItemReference,
    result.kitchenTicketReference,
    result.kitchenReadyResultReference,
    result.sourceEventReference,
    operation.operationReference,
    auditRecord.auditId,
  ];
  if (new Set(references).size !== references.length) return dependency();
  const withoutDigest = Object.freeze({ result, operation, audit: auditRecord });
  return parseFulfillmentReadyEffect({
    ...withoutDigest,
    effectDigest: digest(ports, canonicalReadinessValue(withoutDigest)),
  });
}

async function apply(
  ports: FulfillmentReadinessPorts,
  effect: FulfillmentReadyEffect,
  transaction: ConsumerTransaction,
): Promise<FulfillmentReadyResult> {
  let result: FulfillmentReadinessCommit;
  try {
    result = committed(await ports.repository.apply({ effect, transaction }));
  } catch (error) {
    if (error instanceof FulfillmentReadinessError) throw error;
    return dependency();
  }
  if (result.status === "Conflict") return conflict();
  const persisted = parseFulfillmentReadyEffect(result.effect);
  if (persisted.effectDigest !== effect.effectDigest) return conflict();
  if (result.status === "Applied") {
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
    error instanceof FulfillmentReadinessError &&
    error.code !== "FULFILLMENT_READINESS_DEPENDENCY_UNAVAILABLE"
  )
    return { status: "rejected" as const, errorCode: "CONSUMER_REJECTED" as const };
  return { status: "retry_required" as const, errorCode: "CONSUMER_TEMPORARY_FAILURE" as const };
}

export function createFulfillmentReadinessService(ports: FulfillmentReadinessPorts) {
  async function process(
    sourceEvent: KitchenItemReadyEnvelope,
    transaction: ConsumerTransaction,
  ): Promise<FulfillmentReadyResult> {
    const existing = await resolveExisting(ports, sourceEvent, transaction);
    if (existing !== null) return Object.freeze({ status: "AlreadyApplied", effect: existing });
    const source = await lockSource(ports, sourceEvent, transaction);
    return apply(ports, buildEffect(ports, source, sourceEvent), transaction);
  }

  const registration: ConsumerRegistration = Object.freeze({
    consumerName: fulfillmentItemReadyConsumerName,
    consumerVersion: fulfillmentItemReadyConsumerVersion,
    eventType: "KitchenItemReady",
    schemaVersions: Object.freeze([1]),
    ownerModule: "@rms/fulfillment",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "record_fulfillment_item_ready",
    replaySafe: true,
    handler: async ({ envelope, transaction }: Parameters<ConsumerRegistration["handler"]>[0]) => {
      try {
        const sourceEvent = event(envelope);
        await authorize(ports, sourceEvent);
        const result = await process(sourceEvent, transaction);
        return { status: "completed" as const, resultHash: result.effect.effectDigest.slice(7) };
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
    ): Promise<FulfillmentReadyResult> {
      const sourceEvent = event(value);
      await authorize(ports, sourceEvent);
      let execution: FulfillmentReadyResult | undefined;
      const authorizedRegistration: ConsumerRegistration = Object.freeze({
        ...registration,
        handler: async ({
          transaction: handlerTransaction,
        }: Parameters<ConsumerRegistration["handler"]>[0]) => {
          execution = await process(sourceEvent, handlerTransaction);
          return {
            status: "completed" as const,
            resultHash: execution.effect.effectDigest.slice(7),
          };
        },
      });
      try {
        const outcome = await consumeEventInTransaction(
          transaction,
          authorizedRegistration,
          sourceEvent,
        );
        if (outcome.status === "rejected" || outcome.status === "retry_required")
          return dependency();
      } catch (error) {
        if (error instanceof FulfillmentReadinessError) throw error;
        if (error instanceof ConsumerTransactionRollback)
          return error.outcome.status === "rejected" ? conflict() : dependency();
        return dependency();
      }
      const persisted = await resolveExisting(ports, sourceEvent, transaction);
      if (persisted === null) return dependency();
      return Object.freeze({
        status: execution?.status === "Applied" ? "Applied" : "AlreadyApplied",
        effect: persisted,
      });
    },
  });
}
